
import { Repository, RepositoryState } from './repository';
import { memoize, sequentialize, debounce } from './decorators';
import { Memento, OutputChannel, Disposable, workspace, Uri, EventEmitter, Event } from "vscode";
import { dispose, filterEvent } from "./util";
import { Cvs } from "./cvs";
import * as path from 'path';
import * as fs from 'fs';


export interface ModelChangeEvent {
	repository: Repository;
	uri: Uri;
 }

 export interface OriginalResourceChangeEvent {
	repository: Repository;
	uri: Uri;
}

interface OpenRepository extends Disposable {
	repository: Repository;
}

export class Model
{
	private _onDidOpenRepository = new EventEmitter<Repository>();
	readonly onDidOpenRepository: Event<Repository> = this._onDidOpenRepository.event;

	private _onDidCloseRepository = new EventEmitter<Repository>();
	readonly onDidCloseRepository: Event<Repository> = this._onDidCloseRepository.event;

	private _onDidChangeRepository = new EventEmitter<ModelChangeEvent>();
	readonly onDidChangeRepository: Event<ModelChangeEvent> = this._onDidChangeRepository.event;

	private _onDidChangeOriginalResource = new EventEmitter<OriginalResourceChangeEvent>();
	readonly onDidChangeOriginalResource: Event<OriginalResourceChangeEvent> = this._onDidChangeOriginalResource.event;

	private disposables: Disposable[] = [];
	
	private openRepositories: OpenRepository[] = [];
	get repositories(): Repository[] { return this.openRepositories.map(r => r.repository); }
    
    constructor(readonly cvs: Cvs, private globalState: Memento, private outputChannel: OutputChannel) {
        const fsWatcher = workspace.createFileSystemWatcher('**');
        this.disposables.push(fsWatcher);

        this.scanWorkspaceFolders();
    }

    	/**
	 * Scans the first level of each workspace folder, looking
	 * for cvs repositories.
	 */
	private async scanWorkspaceFolders(): Promise<void> {
		for (const folder of workspace.workspaceFolders || []) {
			const root = folder.uri.fsPath;

			try {
				const children = await new Promise<string[]>((c, e) => fs.readdir(root, (err, r) => err ? e(err) : c(r)));

				//CVS creates a /CVS folder under each directory - check if we have one at the root
				children
					.filter(child => child === 'CVS')
					.forEach(child => this.tryOpenRepository(path.join(root)));
			} catch (err) {
				// noop
			}
		}
    }
    
    @sequentialize
	async tryOpenRepository(path: string): Promise<void> {
		if (this.getRepository(path)) {
			return;
		}

		const config = workspace.getConfiguration('cvs', Uri.file(path));
		const enabled = config.get<boolean>('enabled') !== false;

		if (!enabled) {
			return;
		}

		try {
			//const rawRoot = await this.cvs.getRepositoryRoot(path);
			const rawRoot = path;

			const repositoryRoot = Uri.file(rawRoot).fsPath;

			if (this.getRepository(repositoryRoot)) {
				return;
			}

			const repository = new Repository(this.cvs.open(repositoryRoot), this.globalState);

			this.open(repository);
		} catch (err) {
			// if (err.gitErrorCode === GitErrorCodes.NotAGitRepository) {
			// 	return;
			// }

			 console.error('Failed to find repository:', err);
		}
    }
    
	getRepository(path: string): Repository | undefined;
	getRepository(resource: Uri): Repository | undefined;
	getRepository(hint: any): Repository | undefined 
    {
		const liveRepository = this.getOpenRepository(hint);
		return liveRepository && liveRepository.repository; 
	}
	
	private getOpenRepository(hint: any): OpenRepository | undefined {
		if (!hint) {
			return undefined;
		}

		if (hint instanceof Repository) {
			return this.openRepositories.filter(r => r.repository === hint)[0];
		}

		if (typeof hint === 'string') {
			hint = Uri.file(hint);
		}

		if (hint instanceof Uri) {
			let resourcePath: string;

			// if (hint.scheme === 'cvs') {
			// 	resourcePath = fromGitUri(hint).path;
			// } else {
				resourcePath = hint.fsPath;
			// }

			outer:
			for (const liveRepository of this.openRepositories.sort((a, b) => b.repository.root.length - a.repository.root.length)) {
				// if (!isDescendant(liveRepository.repository.root, resourcePath)) {
				// 	continue;
				// }

				// for (const submodule of liveRepository.repository.submodules) {
				// 	const submoduleRoot = path.join(liveRepository.repository.root, submodule.path);

				// 	if (isDescendant(submoduleRoot, resourcePath)) {
				// 		continue outer;
				// 	}
				// }

				return liveRepository;
			}

			return undefined;
		}

		for (const liveRepository of this.openRepositories) {
			const repository = liveRepository.repository;

			if (hint === repository.sourceControl) {
				return liveRepository;
			}

			// if (hint === repository.mergeGroup || hint === repository.indexGroup || hint === repository.workingTreeGroup) {
			// 	return liveRepository;
			// }
		}

		return undefined;
	}

	private open(repository: Repository): void {
		this.outputChannel.appendLine(`Open repository: ${repository.root}`);

		const onDidDisappearRepository = filterEvent(repository.onDidChangeState, state => state === RepositoryState.Disposed);
		const disappearListener = onDidDisappearRepository(() => dispose());
		const changeListener = repository.onDidChangeRepository(uri => this._onDidChangeRepository.fire({ repository, uri }));
		const originalResourceChangeListener = repository.onDidChangeOriginalResource(uri => this._onDidChangeOriginalResource.fire({ repository, uri }));


		const dispose = () => {
			disappearListener.dispose();
			changeListener.dispose();
			originalResourceChangeListener.dispose();
			repository.dispose();

			this.openRepositories = this.openRepositories.filter(e => e !== openRepository);
			this._onDidCloseRepository.fire(repository);
		};

		const openRepository = { repository, dispose };
		this.openRepositories.push(openRepository);
		this._onDidOpenRepository.fire(repository);
	}

    dispose(): void {
        this.disposables = dispose(this.disposables);
    }
}