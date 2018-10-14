import { IDisposable, filterEvent, eventToPromise, isDescendant } from "./util";
import {
    workspace,
    Uri,
    TextDocumentContentProvider,
    EventEmitter,
    Event,
    Disposable,
    window,
    CancellationToken
  } from "vscode";
import { Model, ModelChangeEvent } from "./model";
import { debounce, throttle } from "./decorators";
import { fromCvsUri } from "./uri";

interface CacheRow {
  uri: Uri;
  timestamp: number;
}

interface Cache {
  [uri: string]: CacheRow;
}

const THREE_MINUTES = 1000 * 60 * 3;
const FIVE_MINUTES = 1000 * 60 * 5;

export class CvsContentProvider implements IDisposable, TextDocumentContentProvider 
{
  private _onDidChange = new EventEmitter<Uri>();
  get onDidChange(): Event<Uri> {
    return this._onDidChange.event;
  }

  private changedRepositoryRoots = new Set<string>();
  private cache: Cache = Object.create(null);
  private disposables: Disposable[] = [];
  
  constructor(private model: Model) {

    this.disposables.push(
      model.onDidChangeRepository(this.onDidChangeRepository, this),
      workspace.registerTextDocumentContentProvider("cvs", this)
    );

    setInterval(() => this.cleanup(), FIVE_MINUTES);
  }

  private onDidChangeRepository({ repository }: ModelChangeEvent): void {
    this.changedRepositoryRoots.add(repository.root);
    this.eventuallyFireChangeEvents();
  }

  @debounce(1100)
  private eventuallyFireChangeEvents(): void {
    this.fireChangeEvents();
  }

  @throttle
  private async fireChangeEvents(): Promise<void> {
    if (!window.state.focused) {
      const onDidFocusWindow = filterEvent(
        window.onDidChangeWindowState,
        e => e.focused
      );
      await eventToPromise(onDidFocusWindow);
    }

    Object.keys(this.cache).forEach(key => {
      const uri = this.cache[key].uri;
      const fsPath = uri.fsPath;

      for (const root of this.changedRepositoryRoots) {
        if (isDescendant(root, fsPath)) {
          this._onDidChange.fire(uri);
          return;
        }
      }
    });

    this.changedRepositoryRoots.clear();
  }



  async provideTextDocumentContent(uri: Uri): Promise<string> {
    try {
      //const { fsPath, action, extra } = fromSvnUri(uri);

      const fsPath = uri.path;

      const repository = this.model.getRepository(fsPath);

      if (!repository) {
        return "";
      }

      // const cacheKey = uri.toString();
      // const timestamp = new Date().getTime();
      // const cacheValue: CacheRow = { uri, timestamp };

      // this.cache[cacheKey] = cacheValue;

      // if (action === SvnUriAction.SHOW) {
      //   const ref = extra.ref;
      //   return await repository.show(fsPath, ref);
      // }
      // if (action === SvnUriAction.LOG) {
      //   return await repository.log();
      // }
      // if (action === SvnUriAction.PATCH) {
      //   return await repository.patch([fsPath]);
      // }
    } catch (error) {}
    return "";
  }

	private cleanup(): void {
		const now = new Date().getTime();
		const cache = Object.create(null);

		Object.keys(this.cache).forEach(key => {
			const row = this.cache[key];
			const { path } = fromCvsUri(row.uri);
			const isOpen = workspace.textDocuments
				.filter(d => d.uri.scheme === 'file')
				.some(d => d.uri.fsPath === path);

			if (isOpen || now - row.timestamp < THREE_MINUTES) {
				cache[row.uri.toString()] = row;
			}
		});

		this.cache = cache;
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}

}