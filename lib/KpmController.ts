import { workspace, Disposable, ExtensionContext } from "vscode";
import { KpmDataManager, completePayloadInfo } from "./KpmDataManager";
import { UNTITLED, UNTITLED_WORKSPACE } from "./Constants";
import { DEFAULT_DURATION } from "./Constants";
import {
    getRootPathForFile,
    isEmptyObj,
    getProjectFolder,
    getDashboardFile,
    getNowTimes,
    logEvent,
    getFileAgeInDays,
    getFileType,
    getSoftwareDataStoreFile,
    codeTimeExtInstalled,
    isFileOpen,
} from "./Util";
import {
    getRepoContributorInfo,
    getRepoFileCount,
    getFileContributorCount,
} from "./KpmRepoManager";
import { sendBatchPayload } from "./DataController";
import { getDataRows, getCurrentPayload } from "./OfflineManager";

const NO_PROJ_NAME = "Unnamed";

let _keystrokeMap = {};
let _staticInfoMap = {};

// batch offline payloads in 50. backend has a 100k body limit
const batch_limit = 5;

export class KpmController {
    private static instance: KpmController;

    private _disposable: Disposable;

    private constructor() {
        let subscriptions: Disposable[] = [];

        workspace.onDidOpenTextDocument(this._onOpenHandler, this);
        // workspace.onDidCloseTextDocument(this._onCloseHandler, this);
        workspace.onDidChangeTextDocument(this._onEventHandler, this);
        this._disposable = Disposable.from(...subscriptions);
    }

    static getInstance(): KpmController {
        if (!KpmController.instance) {
            KpmController.instance = new KpmController();
        }

        return KpmController.instance;
    }

    public allowDocumentListen() {
        // don't listen if code time is installed
        if (!codeTimeExtInstalled()) {
            return true;
        }
        return false;
    }

    public async sendKeystrokeDataIntervalHandler() {
        //
        // Go through all keystroke count objects found in the map and send
        // the ones that have data (data is greater than 1), then clear the map
        // And only if code time is not instaled, post the data
        //
        let latestPayload: any = getCurrentPayload();
        const { local_now_in_sec } = getNowTimes();
        if (
            latestPayload &&
            latestPayload.source &&
            Object.keys(latestPayload.source).length &&
            local_now_in_sec - latestPayload.local_start <= 60
        ) {
            // the one in memory has data right now, use it
            return completePayloadInfo(latestPayload);
        }

        if (_keystrokeMap && !isEmptyObj(_keystrokeMap)) {
            let keys = Object.keys(_keystrokeMap);
            // use a normal for loop since we have an await within the loop
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i];
                const keystrokeCount = _keystrokeMap[key];

                if (keystrokeCount.hasData()) {
                    // post the payload offline until the batch interval sends it out

                    // get the payload
                    latestPayload = { ...keystrokeCount.getLatestPayload() };

                    // post it to the file right away so the song session can obtain it
                    if (!codeTimeExtInstalled()) {
                        await keystrokeCount.postData(latestPayload);
                    }
                }
            }
        }

        // clear out the keystroke map
        _keystrokeMap = {};

        // clear out the static info map
        _staticInfoMap = {};

        return latestPayload;
    }

    /**
     * File Close Handler
     * @param event
     */
    private async _onCloseHandler(event) {
        if (!event || !this.allowDocumentListen()) {
            return;
        }
        const staticInfo = await this.getStaticEventInfo(event);

        if (!this.isTrueEventFile(event, staticInfo.filename)) {
            return;
        }

        let rootPath = getRootPathForFile(staticInfo.filename);

        if (!rootPath) {
            rootPath = UNTITLED;
        }

        await this.initializeKeystrokesCount(staticInfo.filename, rootPath);

        const rootObj = _keystrokeMap[rootPath];
        this.updateStaticValues(rootObj, staticInfo);

        rootObj.source[staticInfo.filename].close += 1;
        logEvent(`File closed: ${staticInfo.filename}`);
    }

    /**
     * File Open Handler
     * @param event
     */
    private async _onOpenHandler(event) {
        if (!event || !this.allowDocumentListen()) {
            return;
        }

        const staticInfo = await this.getStaticEventInfo(event);

        if (!this.isTrueEventFile(event, staticInfo.filename)) {
            return;
        }

        let rootPath = getRootPathForFile(staticInfo.filename);

        if (!rootPath) {
            rootPath = UNTITLED;
        }

        await this.initializeKeystrokesCount(staticInfo.filename, rootPath);

        const rootObj = _keystrokeMap[rootPath];
        this.updateStaticValues(rootObj, staticInfo);

        rootObj.source[staticInfo.filename].open += 1;
        logEvent(`File opened: ${staticInfo.filename}`);
    }

    /**
     * File Change Event Handler
     * @param event
     */
    private async _onEventHandler(event) {
        if (!event || !this.allowDocumentListen()) {
            // code time is installed, let it gather the event data
            return;
        }
        const staticInfo = await this.getStaticEventInfo(event);

        const filename = staticInfo.filename;

        if (!this.isTrueEventFile(event, filename)) {
            return;
        }

        let rootPath = getRootPathForFile(filename);

        if (!rootPath) {
            rootPath = UNTITLED;
        }

        await this.initializeKeystrokesCount(filename, rootPath);

        if (!_keystrokeMap[rootPath].source[filename]) {
            // it's undefined, it wasn't created
            return;
        }

        const rootObj = _keystrokeMap[rootPath];
        const sourceObj = rootObj.source[staticInfo.filename];
        this.updateStaticValues(rootObj, staticInfo);

        //
        // Map all of the contentChanges objects then use the
        // reduce function to add up all of the lengths from each
        // contentChanges.text.length value, but only if the text
        // has a length.
        //

        let isNewLine = false;
        let hasNonNewLineData = false;

        // get the content changes text
        let text = "";

        let hasCotentText =
            event.contentChanges && event.contentChanges.length === 1 ? true : false;
        if (hasCotentText) {
            text = event.contentChanges[0].text || "";
        }

        // check if the text has a new line
        if (text && text.match(/[\n\r]/g)) {
            isNewLine = true;
        } else if (text && text.length > 0) {
            hasNonNewLineData = true;
        }

        let newCount = text ? text.length : 0;

        // check if its a character deletion
        if (
            newCount === 0 &&
            event.contentChanges &&
            event.contentChanges.length === 1 &&
            event.contentChanges[0].rangeLength &&
            event.contentChanges[0].rangeLength > 0
        ) {
            // since new count is zero, check the range length.
            // if there's range length then it's a deletion
            newCount = event.contentChanges[0].rangeLength / -1;
        }

        if (newCount === 0) {
            return;
        }

        if (newCount > 8) {
            //
            // it's a copy and paste event
            //
            sourceObj.paste += 1;
            logEvent("Copy+Paste Incremented");
        } else if (newCount < 0) {
            sourceObj.delete += 1;
            // update the overall count
            logEvent("Delete Incremented");
        } else if (hasNonNewLineData) {
            // update the data for this fileInfo keys count
            sourceObj.add += 1;
            // update the overall count
            logEvent("KPM incremented");
        }
        // increment keystrokes by 1
        rootObj.keystrokes += 1;

        // "netkeys" = add - delete
        sourceObj.netkeys = sourceObj.add - sourceObj.delete;

        let diff = 0;
        if (sourceObj.lines && sourceObj.lines >= 0) {
            diff = staticInfo.lineCount - sourceObj.lines;
        }
        sourceObj.lines = staticInfo.lineCount;
        if (diff < 0) {
            sourceObj.linesRemoved += Math.abs(diff);
            logEvent("Increment lines removed");
        } else if (diff > 0) {
            sourceObj.linesAdded += diff;
            logEvent("Increment lines added");
        }
        if (sourceObj.linesAdded === 0 && isNewLine) {
            sourceObj.linesAdded = 1;
            logEvent("Increment lines added");
        }
    }

    /**
     * Update some of the basic/static attributes
     * @param sourceObj
     * @param staticInfo
     */
    private updateStaticValues(payload, staticInfo) {
        const sourceObj = payload.source[staticInfo.filename];
        // set the repoContributorCount
        if (staticInfo.repoContributorCount && payload.repoContributorCount === 0) {
            payload.repoContributorCount = staticInfo.repoContributorCount;
        }

        // set the repoFileCount
        if (staticInfo.repoFileCount && payload.repoFileCount === 0) {
            payload.repoFileCount = staticInfo.repoFileCount;
        }

        // update the repoFileContributorCount
        if (!sourceObj.repoFileContributorCount) {
            sourceObj.repoFileContributorCount = staticInfo.repoFileContributorCount;
        }

        // syntax
        if (!sourceObj.syntax) {
            sourceObj.syntax = staticInfo.languageId;
        }
        // fileAgeDays
        if (!sourceObj.fileAgeDays) {
            sourceObj.fileAgeDays = staticInfo.fileAgeDays;
        }

        // length
        sourceObj.length = staticInfo.length;
    }

    private async getStaticEventInfo(event) {
        let filename = "";
        let languageId = "";
        let length = 0;
        let lineCount = 0;

        // get the filename, length of the file, and the languageId
        if (event.fileName) {
            filename = event.fileName;
            if (event.languageId) {
                languageId = event.languageId;
            }
            if (event.getText()) {
                length = event.getText().length;
            }
            if (event.lineCount) {
                lineCount = event.lineCount;
            }
        } else if (event.document && event.document.fileName) {
            filename = event.document.fileName;
            if (event.document.languageId) {
                languageId = event.document.languageId;
            }
            if (event.document.getText()) {
                length = event.document.getText().length;
            }

            if (event.document.lineCount) {
                lineCount = event.document.lineCount;
            }
        }

        let staticInfo = _staticInfoMap[filename];

        if (staticInfo) {
            return staticInfo;
        }

        // get the repo count and repo file count
        const contributorInfo = await getRepoContributorInfo(filename);
        const repoContributorCount = contributorInfo ? contributorInfo.count : 0;
        const repoFileCount = await getRepoFileCount(filename);

        // get the file contributor count
        const repoFileContributorCount = await getFileContributorCount(filename);

        // get the age of this file
        const fileAgeDays = getFileAgeInDays(filename);

        // if the languageId is not assigned, use the file type
        if (!languageId && filename.indexOf(".") !== -1) {
            let fileType = getFileType(filename);
            if (fileType) {
                languageId = fileType;
            }
        }

        staticInfo = {
            filename,
            languageId,
            length,
            fileAgeDays,
            repoContributorCount,
            repoFileCount,
            lineCount,
            repoFileContributorCount,
        };

        _staticInfoMap[filename] = staticInfo;

        return staticInfo;
    }

    /**
     * This will return true if it's a true file. we don't
     * want to send events for .git or other event triggers
     * such as extension.js.map events
     */
    private isTrueEventFile(event, filename) {
        if (!filename) {
            return false;
        }
        // if it's the dashboard file or a liveshare tmp file then
        // skip event tracking

        let scheme = "";
        if (event.uri && event.uri.scheme) {
            scheme = event.uri.scheme;
        } else if (event.document && event.document.uri && event.document.uri.scheme) {
            scheme = event.document.uri.scheme;
        }

        const isLiveshareTmpFile = filename.match(
            /.*\.code-workspace.*vsliveshare.*tmp-.*/
        );
        const isInternalFile = filename.match(
            /.*\.software.*(CommitSummary\.txt|CodeTime\.txt|session\.json|ProjectCodeSummary\.txt|data.json)/
        );

        // if it's not active or a liveshare tmp file or internal file or not the right scheme
        // then it's not something to track
        if (
            (scheme !== "file" && scheme !== "untitled") ||
            isLiveshareTmpFile ||
            isInternalFile ||
            !isFileOpen(filename)
        ) {
            return false;
        }
        return true;
    }

    private async initializeKeystrokesCount(filename, rootPath) {
        // the rootPath (directory) is used as the map key, must be a string
        rootPath = rootPath || NO_PROJ_NAME;
        // if we don't even have a _keystrokeMap then create it and take the
        // path of adding this file with a start time of now
        if (!_keystrokeMap) {
            _keystrokeMap = {};
        }

        const nowTimes = getNowTimes();

        let keystrokeCount = _keystrokeMap[rootPath];

        // create the keystroke count if it doesn't exist
        if (!keystrokeCount) {
            // add keystroke count wrapper
            keystrokeCount = this.createKeystrokeCounter(filename, rootPath, nowTimes);
        }

        // check if we have this file or not
        const hasFile = keystrokeCount.source[filename];

        if (!hasFile) {
            // no file, start anew
            this.addFile(filename, nowTimes, keystrokeCount);
        } else if (parseInt(keystrokeCount.source[filename].end, 10) !== 0) {
            // re-initialize it since we ended it before the minute was up
            keystrokeCount.source[filename].end = 0;
            keystrokeCount.source[filename].local_end = 0;
        }

        // close any existing
        const fileKeys = Object.keys(keystrokeCount.source);
        if (fileKeys.length > 1) {
            // set the end time to now for the other files that don't match this file
            fileKeys.forEach((key) => {
                let sourceObj = keystrokeCount.source[key];
                if (key !== filename && sourceObj.end === 0) {
                    sourceObj.end = nowTimes.now_in_sec;
                    sourceObj.local_end = nowTimes.local_now_in_sec;
                }
            });
        }

        _keystrokeMap[rootPath] = keystrokeCount;
    }

    private addFile(filename, nowTimes, keystrokeCount) {
        const fileInfo = {
            add: 0,
            netkeys: 0,
            paste: 0,
            open: 0,
            close: 0,
            delete: 0,
            length: 0,
            lines: 0,
            linesAdded: 0,
            linesRemoved: 0,
            start: nowTimes.now_in_sec,
            local_start: nowTimes.local_now_in_sec,
            end: 0,
            local_end: 0,
            syntax: "",
            fileAgeDays: 0,
            repoFileContributorCount: 0,
            keystrokes: 0,
        };
        keystrokeCount.source[filename] = fileInfo;
    }

    private createKeystrokeCounter(filename, rootPath, nowTimes) {
        const workspaceFolder = getProjectFolder(filename);
        const name = workspaceFolder ? workspaceFolder.name : UNTITLED_WORKSPACE;
        let keystrokeCount = new KpmDataManager({
            // project.directory is used as an object key, must be string
            directory: rootPath,
            name,
            identifier: "",
            resource: {},
        });

        keystrokeCount["start"] = nowTimes.now_in_sec;
        keystrokeCount["local_start"] = nowTimes.local_now_in_sec;
        keystrokeCount["keystrokes"] = 0;

        // start the minute timer to send the data
        setTimeout(() => {
            this.sendKeystrokeDataIntervalHandler();
        }, DEFAULT_DURATION * 1000);

        return keystrokeCount;
    }

    /**
     * Processes code time payloads if code time is not installed
     */
    public async processOfflineKeystrokes() {
        const payloads = await getDataRows(getSoftwareDataStoreFile());
        if (payloads && payloads.length > 0) {
            // build the aggregated payload
            // send 50 at a time
            let batch = [];
            for (let i = 0; i < payloads.length; i++) {
                if (batch.length >= batch_limit) {
                    await sendBatchPayload(batch);
                    batch = [];
                }
                batch.push(payloads[i]);
            }
            if (batch.length > 0) {
                await sendBatchPayload(batch);
            }
        }
    }

    public dispose() {
        this._disposable.dispose();
    }
}
