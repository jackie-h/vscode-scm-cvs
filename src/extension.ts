'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below

import { CvsFinder } from './cvsFinder';
import { Cvs } from './cvs';
import { Model } from './model';
import { ExtensionContext, window, commands, OutputChannel, Disposable, workspace } from 'vscode';
import { filterEvent, eventToPromise } from './util';
import { CvsContentProvider } from './cvsContentProvider';



async function _activate(context: ExtensionContext, disposables: Disposable[]): Promise<Model | undefined> {

    // Use the console to output diagnostic information (console.log) and errors (console.error)
    // This line of code will only be executed once when your extension is activated
    console.log('Congratulations, your extension "CVS" is now active!');

    const outputChannel = window.createOutputChannel("CVS");
    commands.registerCommand("cvs.showOutput", () => outputChannel.show());

    try {
        return await init(context, outputChannel, disposables);
      } catch (err) {
        if (!/Cvs installation not found/.test(err.message || "")) {
          throw err;
        }
    }

    //TODO - remove this when done
    outputChannel.show();

    

    // The command has been defined in the package.json file
    // Now provide the implementation of the command with  registerCommand
    // The commandId parameter must match the command field in package.json
    let disposable = commands.registerCommand('extension.sayHello', () => {
        // The code you place here will be executed every time your command is executed

        // Display a message box to the user
        window.showInformationMessage('Hello World!');
    });

    context.subscriptions.push(disposable);
}

async function init(context: ExtensionContext, outputChannel: OutputChannel, disposables: Disposable[]): Promise<Model>
{
    const cvsFinder = new CvsFinder();
    const cvsInfo = await cvsFinder.findCvs();
    //disposables.push(cvs);
    outputChannel.appendLine(' Using CVS from ' + cvsInfo.path + ' version ' + cvsInfo.version);
    
    const cvs = new Cvs(cvsInfo.path);
    const model = new Model(cvs, context.globalState, outputChannel);
    const contentProvider = new CvsContentProvider(model);
    disposables.push(model, contentProvider);

    return model;
}

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext): Promise<Model | undefined> {

    const config = workspace.getConfiguration('cvs', null);
	const enabled = true; //config.get<boolean>('enabled');

    const disposables: Disposable[] = [];
    context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

    let activatePromise: Promise<Model | undefined>;

    if (enabled)
    {
        activatePromise = _activate(context, disposables);
    } else
    {
        const onConfigChange = filterEvent(workspace.onDidChangeConfiguration, e => e.affectsConfiguration('git'));
		const onEnabled = filterEvent(onConfigChange, () => workspace.getConfiguration('git', null).get<boolean>('enabled') === true);
        activatePromise = eventToPromise(onEnabled).then(()=>_activate(context, disposables));
    }

    activatePromise.catch(err => console.error(err));
    return activatePromise;
}

// this method is called when your extension is deactivated
export function deactivate() {
}