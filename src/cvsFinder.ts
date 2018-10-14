import * as cp from "child_process";
import { CvsClientInfo } from "./cvs";


export function parseVersion(raw: string): string {
    const match = raw.match(/(\d+\.\d+\.\d+ \(r\d+\))/);

    if (match && match[0]) {
        return match[0];
    }
    return raw.split(/[\r\n]+/)[0];
}

export class CvsFinder {
    findCvs(): Promise<CvsClientInfo> {

        const cvs = this.findSvnDarwin();

        return cvs.then(null, () =>
            Promise.reject(new Error("Svn installation not found."))
        );
    }

    findSvnDarwin(): Promise<CvsClientInfo> {
        return new Promise<CvsClientInfo>((c, e) => {
            cp.exec("which cvs", (err, cvsPathBuffer) => {
                if (err) {
                    return e("cvs not found");
                }

                const path = cvsPathBuffer.toString().replace(/^\s+|\s+$/g, "");

                function getVersion(path: string) {
                    // make sure cvs executes
                    cp.exec("cvs --version", (err, stdout) => {
                        if (err) {
                            return e("cvs not found");
                        }
                        return c({ path, version: parseVersion(stdout.trim()) });
                    });
                }

                return getVersion(path);
            });
        });
    }
}

