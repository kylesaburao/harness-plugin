"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.platformPolicy = platformPolicy;
exports.checkGifskiPreflight = checkGifskiPreflight;
exports.checkGifsiclePreflight = checkGifsiclePreflight;
exports.requireReadyCommands = requireReadyCommands;
const resolve_command_js_1 = require("../../../../shared/node/resolve-command.js");
const errors_js_1 = require("./errors.js");
function platformPolicy(platform, backend) {
    if (platform !== 'darwin' && platform !== 'linux')
        throw new errors_js_1.StartupError('platform_unsupported', `unsupported platform: ${platform}`, 'run this converter on macOS, Linux, or inside WSL2');
    const mac = platform === 'darwin';
    const commandRemedy = (name) => {
        if (mac) {
            if (name === 'ffmpeg' || name === 'ffprobe')
                return 'brew install ffmpeg';
            return `brew install ${name}`;
        }
        if (name === 'gifski')
            return 'cargo install gifski, or install the prebuilt binary from https://gif.ski';
        if (name === 'gifsicle')
            return 'sudo apt install gifsicle';
        if (backend === 'gifski')
            return 'sudo apt install ffmpeg (or use a build with libvmaf if the VMAF filter check fails)';
        return 'sudo apt install ffmpeg';
    };
    const installRemedy = backend === 'gifski'
        ? (mac ? 'brew install ffmpeg gifski' : 'sudo apt install ffmpeg; cargo install gifski (or install the prebuilt binary from https://gif.ski)')
        : (mac ? 'brew install ffmpeg gifsicle' : 'sudo apt install ffmpeg gifsicle');
    const libvmafRemedy = mac ? 'brew reinstall ffmpeg' : 'install an ffmpeg build with libvmaf enabled, for example a static build from https://johnvansickle.com/ffmpeg/, jellyfin-ffmpeg, or a source build configured with --enable-libvmaf; the distribution ffmpeg package commonly omits it';
    return { os: platform === 'darwin' ? 'darwin' : 'linux', commandRemedy, installRemedy, libvmafRemedy };
}
async function probe(manager, task, command, args) {
    const result = await manager.runOwned(task, command, args, { stdout: 'capture', stderr: 'capture' });
    return { ...result, output: result.stdout + result.stderr };
}
function listingContains(listing, wanted) {
    return listing.split(/\r?\n/).some(line => {
        const fields = line.trim().split(/\s+/);
        return fields.length > 1 && fields[1].split(',').includes(wanted);
    });
}
function optionListingContains(listing, wanted) {
    return listing.split(/[\s,]+/).some(token => token === wanted || token.startsWith(`${wanted}=`) || token.startsWith(`${wanted}[`));
}
function toolRemedy(platform, tool, action) {
    if (platform === 'darwin')
        return `brew ${action} ${tool === 'ffprobe' ? 'ffmpeg' : tool}`;
    if (tool === 'ffprobe')
        return action === 'reinstall' ? 'reinstall ffmpeg from your package manager or a static build' : 'install an ffprobe build that includes it';
    if (tool === 'gifsicle')
        return `${action} gifsicle from your package manager`;
    return `${action} gifski, for example with cargo install gifski or the prebuilt binary from https://gif.ski`;
}
async function checkFfprobePreflight(manager, state, platform) {
    if (!state.commands.ffprobe)
        return;
    const version = await probe(manager, 'ffprobe-version', state.commands.ffprobe, ['-v', 'error', '-show_program_version', '-of', 'json']);
    if (version.code !== 0 || !version.output.trim())
        state.failures.push({ code: 'ffprobe_probe_failed', condition: 'ffprobe is present but could not report its program version', remedy: toolRemedy(platform, 'ffprobe', 'reinstall') });
    const help = await probe(manager, 'ffprobe-help', state.commands.ffprobe, ['-hide_banner', '-h', 'full']);
    if (help.code !== 0)
        state.failures.push({ code: 'ffprobe_probe_failed', condition: 'ffprobe is present but could not report its options', remedy: toolRemedy(platform, 'ffprobe', 'reinstall') });
    else
        for (const option of ['-of', '-select_streams', '-show_entries', '-count_frames'])
            if (!optionListingContains(help.output, option))
                state.failures.push({ code: 'ffprobe_capability_missing', condition: `ffprobe is missing required option: ${option}`, remedy: toolRemedy(platform, 'ffprobe', 'upgrade') });
}
async function checkCommonPreflight(manager, backend, platform = process.platform, env = process.env) {
    const policy = platformPolicy(platform, backend);
    const names = ['ffmpeg', 'ffprobe', backend];
    const commands = {};
    const failures = [];
    for (const name of names) {
        const resolved = (0, resolve_command_js_1.resolveCommand)(name, env);
        if (resolved)
            commands[name] = resolved;
        else
            failures.push({ code: 'command_missing', condition: `required command not found: ${name}`, remedy: policy.commandRemedy(name) });
    }
    if (commands.ffmpeg) {
        const groups = [
            ['filter', backend === 'gifski' ? ['fps', 'scale', 'format', 'setpts', 'libvmaf'] : ['fps', 'scale', 'format', 'palettegen', 'paletteuse', 'setpts', 'libvmaf']],
            ['encoder', backend === 'gifski' ? ['rawvideo', 'ffv1'] : ['rawvideo', 'ffv1', 'png', 'gif']],
            ['decoder', backend === 'gifski' ? ['rawvideo', 'ffv1', 'gif'] : ['rawvideo', 'ffv1', 'gif', 'png']],
            ['muxer', backend === 'gifski' ? ['yuv4mpegpipe', 'matroska', 'null'] : ['nut', 'matroska', 'image2', 'gif', 'null']],
            ['demuxer', backend === 'gifski' ? ['yuv4mpegpipe', 'matroska', 'gif'] : ['nut', 'matroska', 'image2', 'gif']],
        ];
        for (const [kind, capabilities] of groups) {
            const result = await probe(manager, `ffmpeg-${kind}s`, commands.ffmpeg, ['-hide_banner', `-${kind}s`]);
            if (result.code !== 0)
                failures.push({ code: 'ffmpeg_probe_failed', condition: `ffmpeg could not report its available ${kind}s`, remedy: platform === 'darwin' ? 'brew reinstall ffmpeg' : 'reinstall ffmpeg from your package manager or a static build' });
            else
                for (const capability of capabilities)
                    if (!listingContains(result.output, capability))
                        failures.push({ code: 'ffmpeg_capability_missing', condition: `ffmpeg is missing required ${kind}: ${capability}`, remedy: capability === 'libvmaf' ? policy.libvmafRemedy : (platform === 'darwin' ? 'brew reinstall ffmpeg' : 'install an ffmpeg build that includes it') });
        }
    }
    await checkFfprobePreflight(manager, { commands, failures }, platform);
    return { policy, commands, failures };
}
async function checkGifskiPreflight(manager, platform, env) {
    const state = await checkCommonPreflight(manager, 'gifski', platform, env);
    if (state.commands.gifski) {
        const version = await probe(manager, 'gifski-version', state.commands.gifski, ['--version']);
        if (version.code !== 0 || !version.output.trim())
            state.failures.push({ code: 'gifski_probe_failed', condition: 'gifski is present but could not report its version', remedy: toolRemedy(platform, 'gifski', 'reinstall') });
        const help = await probe(manager, 'gifski-help', state.commands.gifski, ['--help']);
        if (help.code !== 0)
            state.failures.push({ code: 'gifski_probe_failed', condition: 'gifski is present but could not report its options', remedy: toolRemedy(platform, 'gifski', 'reinstall') });
        else
            for (const option of ['--fps', '--width', '--height', '--quality', '--motion-quality', '--lossy-quality', '--repeat', '--quiet', '--output'])
                if (!optionListingContains(help.output, option))
                    state.failures.push({ code: 'gifski_capability_missing', condition: `gifski is missing required option: ${option}`, remedy: toolRemedy(platform, 'gifski', 'upgrade') });
    }
    return state;
}
async function checkGifsiclePreflight(manager, platform, env) {
    const state = await checkCommonPreflight(manager, 'gifsicle', platform, env);
    if (state.commands.gifsicle) {
        const version = await probe(manager, 'gifsicle-version', state.commands.gifsicle, ['--version']);
        if (version.code !== 0 || !version.output.trim())
            state.failures.push({ code: 'gifsicle_probe_failed', condition: 'gifsicle is present but could not report its version', remedy: toolRemedy(platform, 'gifsicle', 'reinstall') });
        const help = await probe(manager, 'gifsicle-help', state.commands.gifsicle, ['--help']);
        if (help.code !== 0)
            state.failures.push({ code: 'gifsicle_probe_failed', condition: 'gifsicle is present but could not report its options', remedy: toolRemedy(platform, 'gifsicle', 'reinstall') });
        else
            for (const option of ['--optimize', '--output'])
                if (!optionListingContains(help.output, option))
                    state.failures.push({ code: 'gifsicle_capability_missing', condition: `gifsicle is missing required option: ${option}`, remedy: toolRemedy(platform, 'gifsicle', 'upgrade') });
    }
    return state;
}
function requireReadyCommands(state, backend) {
    const { ffmpeg, ffprobe } = state.commands;
    const encoder = state.commands[backend];
    if (!ffmpeg || !ffprobe || !encoder)
        throw new errors_js_1.StartupError('command_missing', 'required commands are not ready', state.policy.installRemedy);
    return backend === 'gifski' ? { ffmpeg, ffprobe, gifski: encoder } : { ffmpeg, ffprobe, gifsicle: encoder };
}
