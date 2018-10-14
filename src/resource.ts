import { SourceControlResourceGroup, SourceControlResourceState, Uri } from "vscode";
import { memoize } from "./decorators";

export enum ResourceGroupType {
	WorkingTree
}

export enum Status {
	MODIFIED,
	DELETED,
	UNTRACKED,
    IGNORED,
    ADDED
}

export class Resource implements SourceControlResourceState {

    @memoize
	get resourceUri(): Uri {
		// if (this.renameResourceUri && (this._type === Status.MODIFIED || this._type === Status.DELETED || this._type === Status.INDEX_RENAMED || this._type === Status.INDEX_COPIED)) {
		// 	return this.renameResourceUri;
		// }

		return this._resourceUri;
    }
    
	constructor(
		private _resourceGroupType: ResourceGroupType,
		private _resourceUri: Uri,
		private _type: Status,
		private _useIcons: boolean
	) { }
}

export interface CvsResourceGroup extends SourceControlResourceGroup {
	resourceStates: Resource[];
}