'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveCommand = resolveCommand;
const fs = require("node:fs");
const path = require("node:path");
function resolveCommand(name, env = process.env) {
    for (const directory of (env.PATH || '').split(path.delimiter)) {
        const candidate = path.join(directory || '.', name);
        try {
            if (!fs.statSync(candidate).isFile())
                continue;
            fs.accessSync(candidate, fs.constants.X_OK);
            return fs.realpathSync(candidate);
        }
        catch { }
    }
    return null;
}
