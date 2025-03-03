# M3U8 / HLS Language Support

Visual Studio Code extension providing support for M3U8 (HLS) files and streams.

## Features

### HLS syntax

#### Syntax highlighting
- HLS tags, attributes and their values
- URIs and URLs
- Attribute types: numbers, dates, etc
- Comments
- Unknown (or invalid) tags and attributes (as per the RFC8216 specification)

#### Visual cues
Additional visual cues can be turned on/off through configuration:

- Folding support for segments and associated tags
- Colour banding of segments for easier reading
  - Including specific colors for segments with user-defined tags
- Segment number decoration on each line, with running duration and (where applicable) program date time
- Gutter icons for specific tags (in multivariant playlists and for cues and signals)

![Syntax Highlighting](https://raw.githubusercontent.com/wabiloo/vscode-m3u8-language/main/images/syntax-highlighting.png)


#### Inline documentation

Documentation for spec-compliant tags (and some other common ones) on hover, with links to the relevant sections of the RFC8216 specification 

![Tag Documentation](https://raw.githubusercontent.com/wabiloo/vscode-m3u8-language/main/images/tag-documentation.png)

#### SCTE-35

- Parse SCTE-35 strings (base64 or hex) directly from HLS tags (code lens)
- Parse SCTE-35 strings (base64 or hex) (via palette command `Parse SCTE-35 Data`)
- Display the results in a new tab, formatted or as JSON  

![SCTE-35 Parsing](https://raw.githubusercontent.com/wabiloo/vscode-m3u8-language/main/images/scte35.png)

_This functionality is powered by the [`scte35-js` library](https://github.com/Comcast/scte35-js)_


### Working with HLS streams

#### Remote playlists

All the functionality above is available for local files, but the extensions also make it possible to work with HTTP streams.

- Open and view M3U8 playlists served over HTTP or HTTPS (via palette command `Open Remote Playlist`)
- Auto-refresh support for live playlists with configurable interval (defaulting to #EXT-X-TARGETDURATION) (via status bar button, or palette command `Toggle Auto-Refresh`)
- Manual refresh option for on-demand updates (command `Refresh Current Playlist`)

![Remote Playlist Support](https://raw.githubusercontent.com/wabiloo/vscode-m3u8-language/main/images/remote.gif)

From within a multi-variant playlist, you can also with a simple click open and navigate to any of the variants.

#### Play and download segments

From within a media playlist, you can play and/or download segments with a simple click.

When the semgents require an initialization segment, the extension will automatically download and concatenate it with the segment.

![Play and download segments](https://raw.githubusercontent.com/wabiloo/vscode-m3u8-language/main/images/segment-play.png)

#### Browser monitoring

Ever tried debugging HLS streams in a browser?  I find it is a major pain...

So, this extension also makes it possible to work with streams being played in a web player (via palette command `Open Browser Network Inspector`).
It leverages the Chrome DevTools Protocol, and exposes within a table all requests for M3U8 playlists (on-demand or live).

- Monitor multiple browser tabs, and easily identify what M3U8 requests are made by which tab.
- Refresh the tab content from within VS Code.
- For live playlists, columns show the media sequence and discontinuity sequence tag values.
- Filter the table for any string in the URL
- Highlight in the table any request whose body contains a specific string.
- Click on any row to show the HLS body in a tab. Ctrl/Cmd+click on multiple to open them in separate tabs (ideal to compare them using the standard VS Code diff tool).

![Network Inspector](https://raw.githubusercontent.com/wabiloo/vscode-m3u8-language/main/images/network-inspector.gif)

This feature should work with any web player that uses the Chrome DevTools Protocol, including Chrome, Edge and any Chromium-based browser.

Start your browser with the remote debugging port enabled, which usually involves executing it with the command line argument `--remote-debugging-port=9222`.
If the extension can't detect it, it will offer to (re)start your browser with the correct argument.

You can configure the path to your Chrome/Chromium/Edge executable and the profile directory to use in the extension settings:
* `m3u8.chrome.executablePath`: Set this to the path of your browser executable if it's not in the default location or not automatically detected.
* `m3u8.chrome.profileDirectory`: Set this to use a specific browser profile. Chrome typically stores profiles in directories named 'Default' or 'Profile X' (where X is a number like 1, 2, etc.). Common values are:
  * `Default` - For the default profile
  * `Profile 1`, `Profile 2`, etc. - For additional profiles

By using a specific profile, you can work with multiple browser instances simultaneously, with only one having the remote debugging port enabled. This ensures that you don't need to restart the browser when switching just to use the Network Inspector. I would recommend having a specific profile used for this purpose, and then using the default profile for normal browsing.

When a browser instance is launched by the extension, it will open a new tab with a web player page. By default, this is the HLS.js demo page, but you can configure a different URL in the settings (`m3u8.chrome.defaultPlayerUrl`). 


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
* `m3u8.chrome.executablePath`: Path to the Chrome/Chromium/Edge executable for the Network Inspector. If not set, the extension will try to find a compatible browser automatically.
* `m3u8.chrome.profileDirectory`: Browser profile directory to use with the Network Inspector. If set, it will be used with the `--profile-directory` command line argument.
* `m3u8.chrome.defaultPlayerUrl`: URL to use when creating new browser tabs for HLS monitoring (default: `https://hlsjs.video-dev.org/demo/`). This page should ideally contain HLS video content for testing.

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
* `M3U8 / HLS: Open Browser Network Inspector`: Hook onto a web browser to monitor HLS streams

## Examples

The extension includes example files in the `examples` directory demonstrating some of the features.

## Contributing

Found a bug or have a feature request? Please open an issue on [GitHub](https://github.com/wabiloo/vscode-m3u8-language).

## License

This extension is licensed under the [MIT License](LICENSE).
