'use strict';

import { Uri } from 'vscode';

export interface CvsUriParams {
	path: string;
	ref: string;
	submoduleOf?: string;
}

export function fromCvsUri(uri: Uri): CvsUriParams {
	return JSON.parse(uri.query);
}


