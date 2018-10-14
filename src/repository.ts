'use strict';

import { Disposable, SourceControl, scm, Uri, SourceControlResourceGroup, Memento, EventEmitter, Event, workspace } from "vscode";
import { Repository as BaseRepository} from './cvs';
import { dispose } from './util';

import * as nls from 'vscode-nls';
import { CvsResourceGroup, Resource, ResourceGroupType, Status } from "./resource";
import { throttle } from "./decorators";
import * as path from 'path';

const localize = nls.loadMessageBundle();

export enum Operation {
	Status = 'Status'
}

export enum RepositoryState {
	Idle,
	Disposed
}

function isReadOnly(operation: Operation): boolean {
    return false;
}

function shouldShowProgress(operation: Operation): boolean {
    return true;
}

export interface Operations {
	isIdle(): boolean;
	shouldShowProgress(): boolean;
	isRunning(operation: Operation): boolean;
}

class OperationsImpl implements Operations {

	private operations = new Map<Operation, number>();

	start(operation: Operation): void {
		this.operations.set(operation, (this.operations.get(operation) || 0) + 1);
	}

	end(operation: Operation): void {
		const count = (this.operations.get(operation) || 0) - 1;

		if (count <= 0) {
			this.operations.delete(operation);
		} else {
			this.operations.set(operation, count);
		}
	}

	isRunning(operation: Operation): boolean {
		return this.operations.has(operation);
	}

	isIdle(): boolean {
		const operations = this.operations.keys();

		for (const operation of operations) {
			if (!isReadOnly(operation)) {
				return false;
			}
		}

		return true;
	}

	shouldShowProgress(): boolean {
		const operations = this.operations.keys();

		for (const operation of operations) {
			if (shouldShowProgress(operation)) {
				return true;
			}
		}

		return false;
	}
}

export interface OperationResult {
	operation: Operation;
	error: any;
}

export class Repository implements Disposable {

	private _onDidChangeRepository = new EventEmitter<Uri>();
	readonly onDidChangeRepository: Event<Uri> = this._onDidChangeRepository.event;

	private _onDidChangeState = new EventEmitter<RepositoryState>();
	readonly onDidChangeState: Event<RepositoryState> = this._onDidChangeState.event;

	private _onDidChangeOriginalResource = new EventEmitter<Uri>();
	readonly onDidChangeOriginalResource: Event<Uri> = this._onDidChangeOriginalResource.event;

    private _onRunOperation = new EventEmitter<Operation>();
	readonly onRunOperation: Event<Operation> = this._onRunOperation.event;

	private _onDidRunOperation = new EventEmitter<OperationResult>();
	readonly onDidRunOperation: Event<OperationResult> = this._onDidRunOperation.event;

    private _sourceControl: SourceControl;
    get sourceControl(): SourceControl { return this._sourceControl; }



    private disposables: Disposable[] = [];

    private _state = RepositoryState.Idle;
    get state(): RepositoryState {
      return this._state;
    }
    set state(state: RepositoryState) {
      this._state = state;
      this._onDidChangeState.fire(state);
  
    //   this.changes.resourceStates = [];
    //   this.unversioned.resourceStates = [];
    //   this.conflicts.resourceStates = [];
    //   this.changelists.forEach((group, changelist) => {
    //     group.resourceStates = [];
    //   });
  
    //   this.isIncomplete = false;
    //   this.needCleanUp = false;
    }


    get root(): string {
		return this.repository.root;
    }
    
    private _changes: SourceControlResourceGroup;
    get changesGroup(): CvsResourceGroup { return this._changes as CvsResourceGroup; }

    private _operations = new OperationsImpl();
	get operations(): Operations { return this._operations; }
        

    constructor(private readonly repository: BaseRepository,
                globalState: Memento)
    {
        this._sourceControl = scm.createSourceControl('cvs', 'CVS', Uri.file(repository.root));
        this._changes = this._sourceControl.createResourceGroup('changes', localize('changes', 'Changes'));
        this.disposables.push(this._sourceControl);
        this.disposables.push(this._changes);
    }

    
    @throttle
	private async updateModelState(): Promise<void> {
		const { status, didHitLimit } = await this.repository.getStatus();

		const config = workspace.getConfiguration('cvs');
		const useIcons = !config.get<boolean>('decorations.enabled', true);

		const changesTree: Resource[] = [];

		
		status.forEach(raw => {
			const uri = Uri.file(path.join(this.repository.root, raw.path));
			

			switch (raw.path) {
				case 'M': changesTree.push(new Resource(ResourceGroupType.WorkingTree, uri, Status.MODIFIED, useIcons)); break;
				case 'D': changesTree.push(new Resource(ResourceGroupType.WorkingTree, uri, Status.DELETED, useIcons)); break;
			}
		});

		console.log(status);
    }

    @throttle
    async status() {
      return this.run(Operation.Status);
    }

	private async run<T>(operation: Operation, runOperation: () => Promise<T> = () => Promise.resolve<any>(null)): Promise<T> {
		if (this.state !== RepositoryState.Idle) {
			throw new Error('Repository not initialized');
		}

		let error: any = null;

		this._operations.start(operation);
		this._onRunOperation.fire(operation);

		try {
			const result = await this.retryRun(runOperation);

			if (!isReadOnly(operation)) {
				await this.updateModelState();
			}

			return result;
		} catch (err) {
			error = err;

			// if (err.gitErrorCode === GitErrorCodes.NotAGitRepository) {
			// 	this.state = RepositoryState.Disposed;
			// }

			throw err;
		} finally {
			this._operations.end(operation);
			this._onDidRunOperation.fire({ operation, error });
		}
    }
    
	private async retryRun<T>(runOperation: () => Promise<T> = () => Promise.resolve<any>(null)): Promise<T> {
		let attempt = 0;

		while (true) {
			try {
				attempt++;
				return await runOperation();
			} catch (err) {
                throw err;
				// if (err.gitErrorCode === GitErrorCodes.RepositoryIsLocked && attempt <= 10) {
				// 	// quatratic backoff
				// 	await timeout(Math.pow(attempt, 2) * 50);
				// } else {
				// 	throw err;
				// }
			}
		}
	}    

    
	dispose(): void {
		this.disposables = dispose(this.disposables);
	}
}    