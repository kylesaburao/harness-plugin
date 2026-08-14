# Utils

Small command-line utilities for personal use. Node.js 20.6.0 or newer is necessary.

Install the packages:

```sh
npm install
```

## Available scripts

### Wake a desktop

```sh
npm run wake-desktop
```

Add `MAC_ADDRESS`, `IP_ADDRESS`, and `TIMEOUT` to `.env` before you use the command.

### Make a backup

```sh
npm run backup -- ./backup-config.local.json
```

Read [the backup instructions](src/backup/BACKUP.md) for configuration and safety information.

### Change a video to a GIF

```sh
npm run mov-to-gif -- INPUT_VIDEO [OUTPUT.gif]
```

This macOS script uses `ffmpeg`, `ffprobe`, and `gifsicle`. You can set `MAX_BYTES`, `GIF_SIZE`, `MIN_FPS`, `MAX_FPS`, `JOBS`, or `KEEP_WORK=1`.

### Test the code

```sh
npm test
```

Test only the backup code and collect coverage data:

```sh
npm run test:backup:coverage
```
