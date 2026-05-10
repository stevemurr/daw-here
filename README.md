# daw-here

A single-binary, browser-based DAW-style audition player for folders of multitrack sessions.

Each immediate subdirectory of `--root` is treated as a session; every audio
file inside becomes a track. The browser loads all tracks for a session and
plays them back in sample-accurate sync, with per-track:

- volume, pan, mute, solo
- 3-band EQ (low shelf / sweepable mid peak / high shelf)
- compressor (threshold / ratio / attack / release / makeup)
- delay (time / feedback / mix)
- reverb (room / hall / nonlin) with mix
- input and output gain

Click **FX** in any track header to drop the channel strip below the row.

## Build

Needs Go 1.22+ (for the `net/http` mux pattern syntax).

```sh
go build -o daw-here .
```

The web assets are embedded into the binary via `//go:embed`, so the resulting
executable is fully self-contained — copy it anywhere and run.

For a stripped, smaller binary:

```sh
go build -ldflags="-s -w" -o daw-here .
```

## Run

```sh
./daw-here --root /path/to/sessions
# defaults: --host 127.0.0.1 --port 8765
```

To expose on the LAN:

```sh
./daw-here --host 0.0.0.0 --root /path/to/sessions
```

Then open `http://<host>:8765/`.

## Supported audio

`.wav` `.flac` `.mp3` `.ogg` `.oga` `.opus` `.aif` `.aiff` `.m4a` `.aac`

Decoding is done in the browser via the Web Audio API, so support depends on
your browser. Chrome/Safari/Firefox cover the common formats.

## Notes

- Sessions zipped from Cambridge MT (and similar) often have a single
  redundant top-level directory; the server descends through up to four such
  wrappers to find the actual track files.
- `.DS_Store` and `._*` resource-fork files are ignored.
- Audio is served with HTTP Range support so seeking works over slow networks.
