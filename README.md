# M3U8 / HLS Language Support for VS Code

This extension adds language support for M3U8/HLS (HTTP Live Streaming) playlist files in Visual Studio Code.

## Features

- Syntax highlighting for M3U8/HLS playlist files
- Support for both master playlists and media playlists
- Highlights:
  - HLS directives (e.g., `#EXTM3U`, `#EXT-X-VERSION`, etc.)
  - URIs and URLs
  - Attributes and their values
  - Numbers and durations
  - ISO8601 dates
  - Comments
  - Invalid attributes (as per the Pantos spec)
- Folding support for segments and associated tags
- Colour banding of segments for easier reading
- Segment number decoration on each line

## Supported File Extensions

- `.m3u8`
- `.m3u`

## Example

The extension provides syntax highlighting for M3U8 files like this, whether multi-variant or variant playlists:

```m3u8
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=720x480
http://example.com/video_720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720
http://example.com/video_1080p.m3u8
```

## Installation

1. Open VS Code
2. Press `Ctrl+P` (or `Cmd+P` on macOS)
3. Type `ext install m3u8-hls-vscode`
4. Press Enter

## Development

To build and test the extension locally:

1. Clone the repository
2. Run `npm install`
3. Open the project in VS Code
4. Press F5 to launch the extension in debug mode

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This extension is licensed under the MIT License.

## Release Notes

### 1.0.0

Initial release:
- Basic syntax highlighting for M3U8/HLS files
- Support for common HLS directives and attributes
