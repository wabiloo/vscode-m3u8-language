# M3U8 / HLS Language Support

Visual Studio Code extension providing language support for M3U8 (HLS) files.

## Features

- Syntax highlighting for:
  - HLS tags
  - URIs and URLs
  - Attributes and their values
  - Numbers and durations
  - ISO8601 dates
  - Comments
  - Invalid attributes (as per the HLS specification)

![Syntax Highlighting](images/syntax-highlighting.png)

- Configurable decorations:
  - Folding support for segments and associated tags
  - Colour banding of segments for easier reading
    - Including specific colors for segments with chosen tags
  - Segment number decoration on each line
  - Gutter icons in multivariant playlists
- Documentation for HLS tags on hover, and links to the relevant sections of the HLS specification 

![Tag Documentation](images/tag-documentation.png)

## Supported File Extensions

- `.m3u8`
- `.m3u`

## Extension Settings

This extension contributes the following settings:

* `m3u8.features.colorBanding`: Enable color banding of segments for easier reading (default: `true`)
* `m3u8.features.segmentNumbering`: Show segment numbers in the right margin (default: `true`)
* `m3u8.features.folding`: Enable folding support for segments and associated tags (default: `true`)
* `m3u8.features.gutterIcons`: Show gutter icons for playlist pointers in multivariant playlists (default: `true`)
* `m3u8.features.tagColors`: List of tag colors in format `"TAG,borderColor,backgroundColor"` (default: `[]`)
* `m3u8.features.defaultColors`: Default colors for odd/even segments when no tag colors match (see below)

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

![Settings](images/settings.png)

## Examples

The extension includes example files in the `examples` directory demonstrating various HLS playlist features:

- Basic Media Playlist
- Multivariant Playlist
- Encrypted Media
- Discontinuities
- Alternative Renditions
- And more...

## Contributing

Found a bug or have a feature request? Please open an issue on [GitHub](https://github.com/wabiloo/vscode-m3u8-language).

## License

This extension is licensed under the [MIT License](LICENSE).
