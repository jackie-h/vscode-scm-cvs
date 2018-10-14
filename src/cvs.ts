'use strict';

import * as cp from 'child_process';
import iconv = require('iconv-lite');
import { EventEmitter } from 'events';
import { CancellationToken  } from "vscode";
import { assign, onceEvent, dispose, IDisposable, toDisposable } from './util';
import * as path from 'path';
import * as fs from 'fs';
import { IFileStatus, CvsStatusParser } from './statusParser';

export interface CvsClientInfo
{
   path: string;
   version: string;
}

export interface IExecutionResult<T extends string | Buffer> {
	exitCode: number;
	stdout: T;
	stderr: string;
}

export interface SpawnOptions extends cp.SpawnOptions {
	input?: string;
	encoding?: string;
	log?: boolean;
	cancellationToken?: CancellationToken;
}


async function exec(child: cp.ChildProcess, cancellationToken?: CancellationToken): Promise<IExecutionResult<Buffer>> {
	if (!child.stdout || !child.stderr) {
		throw new CvsError({ message: 'Failed to get stdout or stderr from git process.' });
	}

	if (cancellationToken && cancellationToken.isCancellationRequested) {
		throw new CvsError({ message: 'Cancelled' });
	}

	const disposables: IDisposable[] = [];

	const once = (ee: NodeJS.EventEmitter, name: string, fn: (...args: any[]) => void) => {
		ee.once(name, fn);
		disposables.push(toDisposable(() => ee.removeListener(name, fn)));
	};

	const on = (ee: NodeJS.EventEmitter, name: string, fn: (...args: any[]) => void) => {
		ee.on(name, fn);
		disposables.push(toDisposable(() => ee.removeListener(name, fn)));
	};

	let result = Promise.all<any>([
		new Promise<number>((c, e) => {
			once(child, 'error', cpErrorHandler(e));
			once(child, 'exit', c);
		}),
		new Promise<Buffer>(c => {
			const buffers: Buffer[] = [];
			on(child.stdout, 'data', (b: Buffer) => buffers.push(b));
			once(child.stdout, 'close', () => c(Buffer.concat(buffers)));
		}),
		new Promise<string>(c => {
			const buffers: Buffer[] = [];
			on(child.stderr, 'data', (b: Buffer) => buffers.push(b));
			once(child.stderr, 'close', () => c(Buffer.concat(buffers).toString('utf8')));
		})
	]) as Promise<[number, Buffer, string]>;

	if (cancellationToken) {
		const cancellationPromise = new Promise<[number, Buffer, string]>((_, e) => {
			onceEvent(cancellationToken.onCancellationRequested)(() => {
				try {
					child.kill();
				} catch (err) {
					// noop
				}

				e(new CvsError({ message: 'Cancelled' }));
			});
		});

		result = Promise.race([result, cancellationPromise]);
	}

	try {
		const [exitCode, stdout, stderr] = await result;
		return { exitCode, stdout, stderr };
	} finally {
		dispose(disposables);
	}
}

export interface ICvsErrorData {
	error?: Error;
	message?: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	cvsErrorCode?: string;
	cvsCommand?: string;
}

export class CvsError {

	error?: Error;
	message: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	cvsErrorCode?: string;
	cvsCommand?: string;

	constructor(data: ICvsErrorData) {
		if (data.error) {
			this.error = data.error;
			this.message = data.error.message;
		} else {
			this.error = void 0;
			this.message = '';
		}

		this.message = this.message || data.message || 'CVS error';
		this.stdout = data.stdout;
		this.stderr = data.stderr;
		this.exitCode = data.exitCode;
		this.cvsErrorCode = data.cvsErrorCode;
		this.cvsCommand = data.cvsCommand;
	}

	toString(): string {
		let result = this.message + ' ' + JSON.stringify({
			exitCode: this.exitCode,
			gitErrorCode: this.cvsErrorCode,
			gitCommand: this.cvsCommand,
			stdout: this.stdout,
			stderr: this.stderr
		}, null, 2);

		if (this.error) {
			result += (<any>this.error).stack;
		}

		return result;
	}
}


export class Repository 
{
    constructor(
		private _cvs: Cvs,
		private repositoryRoot: string
	) { }

    get root(): string {
		return this.repositoryRoot;
    }
    
	stream(args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		return this._cvs.stream(this.repositoryRoot, args, options);
	}

	getStatus(limit = 5000): Promise<{ status: IFileStatus[]; didHitLimit: boolean; }> {
		return new Promise<{ status: IFileStatus[]; didHitLimit: boolean; }>((c, e) => {
			const parser = new CvsStatusParser();
			const child = this.stream(['status']);

			const onExit = (exitCode: number) => {
				if (exitCode !== 0) {
					const stderr = stderrData.join('');
					return e(new CvsError({
						message: 'Failed to execute git',
						stderr,
						exitCode,
						//gitErrorCode: getGitErrorCode(stderr),
						cvsCommand: 'status'
					}));
				}

				c({ status: parser.status, didHitLimit: false });
			};

			const onStdoutData = (raw: string) => {
				parser.update(raw);

				if (parser.status.length > limit) {
					child.removeListener('exit', onExit);
					child.stdout.removeListener('data', onStdoutData);
					child.kill();

					c({ status: parser.status.slice(0, limit), didHitLimit: true });
				}
			};

			child.stdout.setEncoding('utf8');
			child.stdout.on('data', onStdoutData);

			const stderrData: string[] = [];
			child.stderr.setEncoding('utf8');
			child.stderr.on('data', raw => stderrData.push(raw as string));

			child.on('error', cpErrorHandler(e));
			child.on('exit', onExit);
		});
	}
}

export class Cvs
{
    readonly path: string;

    private _onOutput = new EventEmitter();
	get onOutput(): EventEmitter { return this._onOutput; }

    constructor(path: string)
    {
        this.path = path;
    }

    open(repository: string): Repository {
		return new Repository(this, repository);
	}

	async init(repository: string): Promise<void> {
		await this.exec(repository, ['init']);
		return;
	}
	

	async getRepositoryRoot(repositoryPath: string): Promise<string> {

		//const root = repositoryPath + "/CVS";
		// try {
			const children = await new Promise<string[]>((c, e) => fs.readdir(repositoryPath, (err, r) => err ? e(err) : c(r)));

			//CVS creates a /CVS folder under each directory - check if we have one at the root
			//const cvsDir = children.filter(child => child === 'CVS');

			const root = await new Promise<string>((c, e) => fs.readFile(repositoryPath + "/CVS/Root", "UTF-8", (err, d) => err ? e(err) : c(d)));

			return root.split("\n")[0];
		// } catch (err) {
		// 	// noop
		// }
		//const result = await this.exec(repositoryPath, ['rev-parse', '--show-toplevel']);
		//return this.path.normalize(result.stdout.trim());
	}



	async exec(cwd: string, args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		options = assign({ cwd }, options || {});
		return await this._exec(args, options);
	}

	
	
	stream(cwd: string, args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		options = assign({ cwd }, options || {});
		return this.spawn(args, options);
	}
    
    private async _exec(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
		const child = this.spawn(args, options);

		if (options.input) {
			child.stdin.end(options.input, 'utf8');
		}

		const bufferResult = await exec(child, options.cancellationToken);

		if (options.log !== false && bufferResult.stderr.length > 0) {
			this.log(`${bufferResult.stderr}\n`);
		}

		let encoding = options.encoding || 'utf8';
		encoding = iconv.encodingExists(encoding) ? encoding : 'utf8';

		const result: IExecutionResult<string> = {
			exitCode: bufferResult.exitCode,
			stdout: iconv.decode(bufferResult.stdout, encoding),
			stderr: bufferResult.stderr
		};

		if (bufferResult.exitCode) {
			return Promise.reject<IExecutionResult<string>>(new CvsError({
				message: 'Failed to execute cvs',
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				//gitErrorCode: getGitErrorCode(result.stderr),
				cvsCommand: args[0]
			}));
		}

		return result;
    }
    
    spawn(args: string[], options: SpawnOptions = {}): cp.ChildProcess {
		if (!this.path) {
			throw new Error('git could not be found in the system.');
		}

		if (!options) {
			options = {};
		}

		if (!options.stdio && !options.input) {
			options.stdio = ['ignore', null, null]; // Unless provided, ignore stdin and leave default streams for stdout and stderr
		}

		// options.env = assign({}, process.env, this.env, options.env || {}, {
		// 	VSCODE_GIT_COMMAND: args[0],
		// 	LC_ALL: 'en_US.UTF-8',
		// 	LANG: 'en_US.UTF-8'
		// });

		// if (options.log !== false) {
		// 	this.log(`> git ${args.join(' ')}\n`);
		// }

		return cp.spawn(this.path, args, options);
	}

	private log(output: string): void {
		this._onOutput.emit('log', output);
	}
}

function cpErrorHandler(cb: (reason?: any) => void): (reason?: any) => void {
	return err => {
		
        //TODO - does this make sense for CVS
		if (/ENOENT/.test(err.message)) {
			err = new CvsError({
				error: err,
				message: 'Failed to execute cvs (ENOENT)'
			});
		}

		cb(err);
	};
}

