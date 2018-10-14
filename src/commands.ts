import { workspace, window, Uri, Disposable, OutputChannel, commands, MessageOptions  } from "vscode";
import { Model } from "./model";
import { Cvs } from "./cvs";
import * as os from 'os';
import * as nls from 'vscode-nls';
import { Repository } from "./repository";

const localize = nls.loadMessageBundle();

interface CommandOptions {
	repository?: boolean;
	diff?: boolean;
}

interface Command {
	commandId: string;
	key: string;
	method: Function;
	options: CommandOptions;
}

const Commands: Command[] = [];

function command(commandId: string, options: CommandOptions = {}): Function {
	return (target: any, key: string, descriptor: any) => {
		if (!(typeof descriptor.value === 'function')) {
			throw new Error('not supported');
		}

		Commands.push({ commandId, key, method: descriptor.value, options });
	};
}

export class CommandCenter {

    private disposables: Disposable[];

	constructor(
		private cvs: Cvs,
		private model: Model,
		private outputChannel: OutputChannel
	) {
		this.disposables = Commands.map(({ commandId, key, method, options }) => {
			const command = this.createCommand(commandId, key, method, options);

			// if (options.diff) {
			// 	return commands.registerDiffInformationCommand(commandId, command);
			// } else {
				return commands.registerCommand(commandId, command);
			//}
		});
    }
    
    private createCommand(id: string, key: string, method: Function, options: CommandOptions): (...args: any[]) => any {
		const result = (...args: any[]) => {
			let result: Promise<any>;

			if (!options.repository) {
				result = Promise.resolve(method.apply(this, args));
			} else {
				// try to guess the repository based on the first argument
				const repository = this.model.getRepository(args[0]);
				let repositoryPromise: Promise<Repository | undefined>;

				if (repository) {
					repositoryPromise = Promise.resolve(repository);
				} else if (this.model.repositories.length === 1) {
					repositoryPromise = Promise.resolve(this.model.repositories[0]);
                } else {
					repositoryPromise = Promise.resolve(undefined); //this.model.pickRepository();
				}

				result = repositoryPromise.then(repository => {
					if (!repository) {
						return Promise.resolve();
					}

					return Promise.resolve(method.apply(this, [repository, ...args]));
				});
			}

			/* __GDPR__
				"git.command" : {
					"command" : { "classification": "SystemMetaData", "purpose": "FeatureInsight" }
				}
			*/
			//this.telemetryReporter.sendTelemetryEvent('git.command', { command: id });

			return result.catch(async err => {
				 const options: MessageOptions = {
				 	//modal: err.gitErrorCode === GitErrorCodes.DirtyWorkTree
				 };

				let message: string;

				switch (err.gitErrorCode) {
					// case GitErrorCodes.DirtyWorkTree:
					// 	message = localize('clean repo', "Please clean your repository working tree before checkout.");
					// 	break;
					// case GitErrorCodes.PushRejected:
					// 	message = localize('cant push', "Can't push refs to remote. Try running 'Pull' first to integrate your changes.");
					// 	break;
					default:
						const hint = (err.stderr || err.message || String(err))
							.replace(/^error: /mi, '')
							.replace(/^> husky.*$/mi, '')
							.split(/[\r\n]/)
							.filter((line: string) => !!line)
						[0];

						message = hint
							? localize('git error details', "Git: {0}", hint)
							: localize('git error', "Git error");

						break;
				}

				if (!message) {
					console.error(err);
					return;
				}

				options.modal = true;

				const outputChannel = this.outputChannel as OutputChannel;
				const openOutputChannelChoice = localize('open git log', "Open Git Log");
				const choice = await window.showErrorMessage(message, options, openOutputChannelChoice);

				if (choice === openOutputChannelChoice) {
					outputChannel.show();
				}
			});
		};

		// patch this object, so people can call methods directly
		(this as any)[key] = result;

		return result;
	}

    @command('git.init')
	async init(): Promise<void> {
		let path: string | undefined;

		if (workspace.workspaceFolders && workspace.workspaceFolders.length > 1) {
			const placeHolder = localize('init', "Pick workspace folder to initialize git repo in");
			const items = workspace.workspaceFolders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder }));
			const item = await window.showQuickPick(items, { placeHolder, ignoreFocusOut: true });

			if (!item) {
				return;
			}

			path = item.folder.uri.fsPath;
		}

		if (!path) {
			const homeUri = Uri.file(os.homedir());
			const defaultUri = workspace.workspaceFolders && workspace.workspaceFolders.length > 0
				? Uri.file(workspace.workspaceFolders[0].uri.fsPath)
				: homeUri;

			const result = await window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				canSelectMany: false,
				defaultUri,
				openLabel: localize('init repo', "Initialize Repository")
			});

			if (!result || result.length === 0) {
				return;
			}

			const uri = result[0];

			if (homeUri.toString().startsWith(uri.toString())) {
				const yes = localize('create repo', "Initialize Repository");
				const answer = await window.showWarningMessage(localize('are you sure', "This will create a Git repository in '{0}'. Are you sure you want to continue?", uri.fsPath), yes);

				if (answer !== yes) {
					return;
				}
			}

			path = uri.fsPath;
		}

		await this.cvs.init(path);
		await this.model.tryOpenRepository(path);
	}
}