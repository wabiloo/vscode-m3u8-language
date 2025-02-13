# M3U8 / HLS Language Support

Visual Studio Code extension providing language support for M3U8 (HLS) files.

## Features

- Syntax highlighting for:
  - HLS tags, attributes and their values
  - URIs and URLs
  - Numbers and durations, date, strings
  - Comments
  - Invalid attributes (as per the HLS specification)

![Syntax Highlighting](https://raw.githubusercontent.com/wabiloo/vscode-m3u8-language/main/images/syntax-highlighting.png)

- Remote playlist support:
  - Open and view remote M3U8 playlists directly in VS Code
  - Clickable links to navigate between multi-variant playlists and variants
  - Auto-refresh support for live playlists with configurable interval (defaulting to #EXT-X-TARGETDURATION)
  - Manual refresh option for on-demand updates
  - Download segments from media playlists with a single click
  - Smart link handling: opens playlists, downloads segments

![Remote Playlist Support](https://raw.githubusercontent.com/wabiloo/vscode-m3u8-language/main/images/remote.gif)

- SCTE-35 parsing:
  - Parse a SCTE-35 payload with a command
  - Parse SCTE-35 payloads in HLS tags in the current file (code lens)
  - Display the results in a new tab, formatted or as JSON  

![SCTE-35 Parsing](https://raw.githubusercontent.com/wabiloo/vscode-m3u8-language/main/images/scte35.png)

- Configurable decorations:
  - Folding support for segments and associated tags
  - Colour banding of segments for easier reading
    - Including specific colors for segments with chosen tags
  - Segment number decoration on each line, with running duration and (where applicable) program date time
  - Gutter icons for specific tags (in multivariant playlists and for cues and signals)
- Documentation for HLS tags on hover, and links to the relevant sections of the HLS specification 

![Tag Documentation](https://raw.githubusercontent.com/wabiloo/vscode-m3u8-language/main/images/tag-documentation.png)

## Supported File Extensions

- `.m3u8`
- `.m3u`

## Extension Settings

This extension contributes the following settings:

* `m3u8.features.colorBanding`: Enable color banding of segments for easier reading (default: `true`)
* `m3u8.features.segmentNumbering`: Show segment numbers in the right margin (default: `true`)
* `m3u8.features.folding`: Enable folding support for segments and associated tags (default: `true`)
* `m3u8.features.gutterIcons`: Show gutter icons for playlist pointers in multivariant playlists (default: `true`)
* `m3u8.features.showRunningDuration`: Show running duration for each segment (default: `true`)
* `m3u8.features.showProgramDateTime`: Show effective timestamp for each segment (default: `true`)
* `m3u8.features.clickableLinks`: Enable clickable links for URIs in playlists (default: `true`)
* `m3u8.features.tagColors`: List of tag colors in format `"TAG,borderColor,backgroundColor"` (default: `[]`)
* `m3u8.features.defaultColors`: Default colors for odd/even segments when no tag colors match (see below)
* `m3u8.features.showTagDocumentation`: Show documentation tooltips for HLS tags (default: `true`)
### Default Colors

The `m3u8.features.defaultColors` setting allows you to customize the colors used for alternating segments when no tag colors match. The default values are:

```json
{
    "odd": {
        "backgroundColor": "rgba(25, 35, 50, 0.35)",
        "borderColor": "rgba(50, 120, 220, 0.8)"
    },
    "even": {
        "backgroundColor": "rgba(40, 55, 75, 0.25)",
        "borderColor": "rgba(100, 160, 255, 0.6)"
    }
}
```

![Settings](https://raw.githubusercontent.com/wabiloo/vscode-m3u8-language/main/images/settings.png)

## Commands

The extension provides the following commands:

* `M3U8 / HLS: Open Remote Playlist`: Open a remote M3U8 playlist by entering its URL
* `M3U8 / HLS: Refresh Current Playlist`: Manually refresh the current remote playlist
* `M3U8 / HLS: Toggle Auto-Refresh`: Enable or disable automatic refreshing of the current remote playlist (not available for multi-variant playlists)
* `M3U8 / HLS: Parse SCTE-35 Payload`: Parse a SCTE-35 payload and display the results in a new tab

## Examples

The extension includes example files in the `examples` directory demonstrating some of the features.

## Contributing

Found a bug or have a feature request? Please open an issue on [GitHub](https://github.com/wabiloo/vscode-m3u8-language).

## License

This extension is licensed under the [MIT License](LICENSE).
