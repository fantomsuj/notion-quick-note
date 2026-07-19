# Bundled design assets

The four NotionInter WOFF2 files are the approved copies referenced by the fidelity preview and are packaged locally so extension UI never requests remote fonts. Their original filenames, weights, and bytes are preserved.

`brand/notion-mark.svg` is the approved monochrome Notion cube artwork from Notion's media kit. The checked-in SVG is the public media-kit copy mirrored by Wikimedia Commons; it is never fetched at runtime.

The fallback `Inter` family is not bundled. It is available under the [SIL Open Font License](https://github.com/rsms/inter/blob/master/LICENSE.txt).
