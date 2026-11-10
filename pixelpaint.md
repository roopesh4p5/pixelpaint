import pypandoc

md = r"""# PixelPaint — Developer Product Requirements Document

**Document type:** Product Requirements Document (PRD) + Technical Design Specification  
**Product:** PixelPaint  
**Version:** 1.0  
**Status:** Implementation-ready product specification  
**Architecture:** Single-file, client-side web application  
**Technology:** HTML5, CSS3, vanilla JavaScript, browser APIs, optional lightweight non-AI libraries  
**AI policy:** Strictly prohibited — no AI, no LLMs, no machine-learning models, no generative features, no cloud inference

---

## 1. Product overview

PixelPaint is an advanced, browser-based image editor designed to combine the accessibility of Microsoft Paint with the practical editing capabilities expected from a professional raster graphics application.

The application must be delivered as **one self-contained HTML file** containing its HTML structure, CSS, and JavaScript. The user opens the file in a modern browser and edits images locally. Core editing must not require a backend, account, network connection, build system, package manager, or server.

PixelPaint is based entirely on deterministic, conventional image-processing logic:

- Pointer and mouse geometry
- Canvas 2D rendering
- Pixel arrays and typed arrays
- Selection masks
- Color-distance calculations
- Flood-fill algorithms
- Edge-aware selection techniques
- Convolution kernels
- Histogram calculations
- Geometric transforms
- Classical computer-vision algorithms, if included
- Browser storage and file APIs

There must be no AI-assisted selection, semantic subject recognition, neural networks, generative fill, LLMs, external AI APIs, or hidden remote processing.

### 1.1 Product promise

A user can import an image, manually outline an object with an irregular freehand path, refine the selection boundary, remove the surrounding pixels, preserve transparency, edit the result, and export it — all locally in the browser.

### 1.2 Core design principle

**The user controls the selection. Algorithms refine and execute the user's instructions; they do not infer what the user intended.**

For example, when cutting a person out of a photograph:

1. The user selects the freehand lasso tool.
2. The user traces around the person using a mouse, stylus, or finger.
3. PixelPaint records the pointer path in document coordinates.
4. The path is closed to create a selection region.
5. The region is rasterized into an antialiased selection mask.
6. The user can refine the edge using feather, expand, contract, smooth, and manual mask brushes.
7. The user chooses **Remove Outside** or **Copy Selection to New Layer**.
8. PixelPaint applies the mask to the image alpha channel.
9. The transparent result can be exported as PNG.

No AI subject detection is involved.

---

## 2. Goals and non-goals

### 2.1 Goals

- Deliver the complete application in one HTML file.
- Work offline after the file is available locally.
- Require no backend or account.
- Support desktop mouse, trackpad, stylus, and touch interaction.
- Provide advanced manual selection and cutout workflows.
- Preserve transparency and source image quality.
- Support layers, masks, drawing, transforms, adjustments, and filters.
- Persist useful work locally using browser storage.
- Provide undo and redo with predictable results.
- Keep the UI responsive during large image operations.
- Make every tool understandable and controllable.
- Use deterministic algorithms with documented behavior.

### 2.2 Non-goals

- No AI or machine learning of any kind.
- No LLM features or natural-language editing.
- No semantic person/object/sky detection.
- No generative fill or image synthesis.
- No cloud rendering, cloud storage, or remote inference.
- No required user registration.
- No mandatory backend.
- No Photoshop-compatible PSD editing requirement in the first release.
- No promise that automatic classical algorithms can perfectly isolate every complex subject.

---

## 3. Non-negotiable technical constraints

### 3.1 Single-file delivery

The deliverable is `PixelPaint.html`.

It must contain:

- All application HTML.
- All application CSS in a `<style>` element.
- All application JavaScript in one or more `<script>` elements.
- Inline SVG icons where needed.
- No required external CSS, JavaScript, image, font, or runtime files.

The file may optionally use a CDN-hosted library when internet access is available, but the core editor must not depend on it. The preferred release is self-contained and works offline. If a third-party library is bundled, its code must be embedded in the HTML and its license included in a visible or documented license section.

### 3.2 No AI policy

Prohibited:

- TensorFlow, PyTorch, ONNX models, neural networks, or equivalent model runtimes.
- AI-powered background removal.
- AI-powered object selection.
- Generative fill or generative image editing.
- LLM APIs or chat features.
- Remote image-processing services.
- Hidden image uploads or telemetry.

Allowed:

- Canvas 2D.
- WebGL2 shaders for deterministic filters.
- Web Workers created from inline Blob URLs.
- OffscreenCanvas when supported.
- IndexedDB, localStorage, sessionStorage.
- File, Blob, FileReader, URL, ImageBitmap APIs.
- Classical algorithms such as flood fill, color thresholding, edge detection, GrabCut (if a library is embedded), and inpainting.
- User-guided selection and manual mask editing.

### 3.3 Browser compatibility

Target modern versions of:

- Chrome / Chromium
- Microsoft Edge
- Firefox
- Safari

Feature detection is mandatory. Unsupported APIs must have a fallback. The application must not fail to open merely because OffscreenCanvas, WebGL2, or a particular storage API is unavailable.

---

## 4. User experience and interface

### 4.1 Layout

Use a professional dark graphite interface.

**Top menu**
- File
- Edit
- Image
- Layer
- Select
- Adjustments
- Filters
- View
- Help

**Top contextual toolbar**
- Current tool name
- Tool-specific settings
- Brush size
- Hardness
- Opacity
- Feather
- Fill and stroke
- Apply / Cancel where appropriate

**Left toolbar**
- Move
- Hand / Pan
- Zoom
- Rectangular selection
- Elliptical selection
- Freehand lasso
- Polygon lasso
- Magnetic-style edge-assisted lasso (classical edge snapping only)
- Magic Wand
- Color Range
- Brush
- Pencil
- Eraser
- Fill bucket
- Color picker
- Clone stamp
- Healing brush
- Crop
- Text
- Line
- Rectangle
- Ellipse
- Polygon

**Center**
- Main document viewport
- Checkerboard transparency background
- Canvas overlays
- Selection boundary (“marching ants”)
- Transform handles
- Rulers and optional guides

**Right panel**
- Layers
- Layer properties
- Selection properties
- Adjustments
- History

**Bottom status bar**
- Zoom percentage
- Document width and height
- Cursor coordinates
- Current tool
- Selection dimensions when available
- Processing status

Panels must be collapsible. The workspace must adapt to narrow tablet and phone viewports.

### 4.2 Interaction principles

- Mouse, stylus, and touch must use Pointer Events where supported.
- Prevent accidental page scrolling while drawing on the canvas.
- Use pointer capture during active strokes.
- Keep tool controls contextual.
- Show a clear active-tool state.
- Provide keyboard shortcuts, but do not intercept typing while an input, textarea, or editable text object is focused.
- Support high-DPI displays without changing document pixel dimensions.
- Distinguish document coordinates from screen coordinates.

---

## 5. Document and image model

### 5.1 Document

Each open document contains:

- Unique ID
- Document name
- Width and height in pixels
- Resolution metadata where available
- Color-space declaration (initially sRGB)
- Background configuration
- Ordered layers
- Active layer ID
- Selection mask, if any
- Guides and grid settings
- History state
- Creation and modification timestamps

### 5.2 Layer types

Initial layer types:

- Raster image
- Paint
- Shape
- Text
- Group
- Adjustment
- Background

Each layer should have:

- ID
- Name
- Type
- Visibility
- Lock state
- Opacity
- Blend mode
- Position
- Scale X / Y
- Rotation
- Optional alpha mask
- Pixel or vector content reference
- Parent group ID where relevant

### 5.3 Pixel representation

Use Canvas 2D for display and `ImageData` / `Uint8ClampedArray` for pixel operations when needed.

An RGBA pixel uses four 8-bit channels:

- Red: 0–255
- Green: 0–255
- Blue: 0–255
- Alpha: 0–255

Do not repeatedly copy full-resolution pixel buffers unnecessarily. Keep source assets separate from working previews where possible.

---

## 6. Import, documents, and export

### 6.1 Import formats

Required:

- PNG
- JPEG / JPG
- WebP
- BMP where browser decoding supports it
- SVG, after sanitization and safe rasterization

Import methods:

- File picker
- Drag and drop
- Clipboard paste where browser permissions allow
- Multiple images as separate layers

On import:

- Read image dimensions.
- Correct EXIF orientation where possible.
- Preserve original source bytes in the project session.
- Create an image layer.
- Fit the image to the viewport without resampling the source document.
- Report unsupported or invalid files clearly.

### 6.2 Export

Required output:

- PNG with transparency
- JPEG with quality control and configurable background flattening
- WebP with quality control where supported

Export options:

- Entire flattened document
- Active layer
- Selected region
- Custom output dimensions
- Preserve transparent pixels for PNG/WebP where supported

The editor must never silently flatten the editable document when the user chooses Save Project.

### 6.3 Project save format

The native project format should be a versioned JSON-based package with binary image assets. In a single-file application, implement a practical `.pforge` format as a ZIP package if a ZIP library is embedded, or as a versioned JSON file with embedded base64 assets for the first implementation.

A project must preserve:

- Document dimensions
- Layer order and properties
- Original assets
- Text and shape definitions
- Masks
- Adjustment parameters
- Selection state where practical
- History checkpoints where practical

Validate project version and structure before loading. Reject malformed or excessively large data safely.

---

## 7. Selection system — critical feature

Selection is a first-class subsystem, not a temporary drawing overlay.

### 7.1 Selection representation

Represent selections as a grayscale mask with the same pixel dimensions as the document:

- 0 = fully unselected
- 255 = fully selected
- 1–254 = partially selected / antialiased / feathered

A mask allows accurate alpha compositing and non-destructive editing.

Maintain selection geometry in document coordinates. Viewport zoom and pan must never alter the actual selection.

### 7.2 Freehand lasso — primary manual cutout tool

This is the most important user-controlled cutout workflow.

**User action**

The user presses and drags around an object with an uneven hand-drawn path. The path does not need to be geometrically perfect. The user decides where the boundary should be.

**Implementation**

1. On `pointerdown`, begin a path and capture the pointer.
2. Convert pointer screen coordinates to document coordinates.
3. Add points while the pointer moves.
4. Reduce redundant points using a configurable distance threshold.
5. Optionally smooth jitter using a light path simplification algorithm, preserving the overall traced contour.
6. On pointer release, close the path.
7. Rasterize the path into a selection mask using Canvas 2D with antialiasing.
8. Apply optional feathering to the mask.
9. Display the selection boundary.
10. Allow the user to refine or apply the selection.

**Important:** Do not replace the user's path with an automatically inferred subject boundary. The recorded path is the authority.

### 7.3 Lasso editing behavior

- Add to selection
- Subtract from selection
- Intersect with selection
- Replace selection
- Close path automatically on release
- Cancel current path with Escape
- Undo last selection operation
- Optional smoothing amount
- Optional feather radius
- Zoom and pan while retaining document coordinates

### 7.4 Polygon lasso

The user clicks to place vertices and double-clicks or closes the polygon to finish. Provide:

- Vertex preview
- Backspace to remove last vertex
- Escape to cancel
- Add/subtract/intersect modes
- Antialiased rasterization

### 7.5 Rectangular and elliptical selections

Support drag-to-create, modifier keys for centered or constrained proportions, and add/subtract/intersect modes.

### 7.6 Magnetic-style lasso (optional advanced tool)

A conventional edge-snapping tool may help the user trace strong image boundaries. It must be deterministic and user-guided.

Possible method:

- Compute local gradient magnitude using Sobel filters.
- Search within a small radius around the pointer for a strong edge candidate.
- Snap the path to the strongest nearby candidate.
- Let the user add anchor points to prevent incorrect snapping.
- Provide sensitivity, search radius, and edge strength settings.

This is edge detection, not AI. It must never claim to identify a person or object.

### 7.7 Magic Wand

Select connected pixels within a color-distance threshold.

Controls:

- Tolerance
- Contiguous on/off
- Sample merged / active layer
- Anti-alias
- Feather
- Add / subtract / intersect

Use a documented color-distance metric, initially RGB Euclidean distance or a perceptual color space such as CIELAB if implemented correctly.

### 7.8 Color Range

Select pixels across the image based on a chosen color and tolerance. Unlike contiguous Magic Wand, this can select matching colors in disconnected regions.

### 7.9 Selection refinement

Required operations:

- Expand
- Contract
- Feather
- Smooth
- Border
- Invert
- Clear
- Select all
- Deselect
- Save selection as mask
- Load mask as selection

Feather should blur the grayscale selection mask, not blur the image itself.

### 7.10 Manual mask refinement

Provide two mask-editing modes:

- Reveal: paint white into the mask.
- Hide: paint black into the mask.

Controls:

- Brush diameter
- Hardness
- Opacity
- Flow
- Edge preview
- Overlay color and opacity

The user must be able to repair missed areas manually.

---

## 8. Cutout and background removal workflow

### 8.1 Remove outside selection

For each pixel:

`outputAlpha = sourceAlpha × selectionMask / 255`

Pixels outside the selection become transparent. Pixels on antialiased edges retain partial alpha.

### 8.2 Remove inside selection

For each pixel:

`outputAlpha = sourceAlpha × (255 - selectionMask) / 255`

### 8.3 Copy selection to new layer

- Create a new raster layer.
- Copy the selected RGBA pixels.
- Multiply alpha by the selection mask.
- Preserve document coordinates and layer placement.
- Optionally keep the original layer unchanged.

### 8.4 Cut selection

- Copy selected pixels to clipboard or an internal clipboard buffer.
- Apply the inverse mask to the original layer.
- Preserve transparency.
- Support undo.

### 8.5 Background removal modes

1. **Manual lasso:** user traces the foreground boundary.
2. **Magic Wand:** user chooses a background color and tolerance.
3. **Color Range:** select matching background colors across the image.
4. **Chroma Key:** remove a chosen key color with tolerance and spill controls.
5. **Flood Fill:** remove a connected region from a clicked seed point.
6. **Edge-assisted lasso:** optional user-guided gradient snapping.
7. **Manual mask brush:** repair all of the above.

Do not advertise semantic one-click subject removal. There is no AI subject detection.

### 8.6 Chroma key

Implement color-distance thresholding with a soft transition:

- Key color picker
- Tolerance
- Edge softness
- Spill suppression
- Preview on checkerboard, black, white, and custom backgrounds

### 8.7 Flood fill

Use a queue-based or scanline flood-fill algorithm. Avoid recursive flood fill because large images can overflow the JavaScript call stack.

Support:

- Contiguous region
- Tolerance
- 4-way or 8-way connectivity
- Active layer or merged sample
- Selection restriction

---

## 9. Drawing and painting tools

Required tools:

- Pencil
- Brush
- Soft brush
- Airbrush
- Eraser
- Fill bucket
- Color picker
- Line
- Rectangle
- Rounded rectangle
- Ellipse
- Polygon
- Arrow
- Text
- Clone stamp
- Healing brush

Brush controls:

- Diameter
- Hardness
- Opacity
- Flow
- Spacing
- Smoothing
- Color
- Blend mode

Use pointer pressure when available, with sensible mouse fallback. Do not assume pressure support.

### 9.1 Eraser

The eraser must support:

- Brush size
- Hardness
- Opacity
- Layer alpha removal
- Selection restriction
- Undo

### 9.2 Text

Text remains editable until rasterized.

Controls:

- Font family
- Font size
- Weight
- Italic
- Underline
- Alignment
- Line height
- Letter spacing
- Fill color
- Outline
- Shadow
- Rotation

### 9.3 Clone stamp

- User chooses a source point.
- User paints a destination stroke.
- Support aligned and non-aligned sampling.
- Support active-layer and merged-image sampling.
- Brush size, hardness, opacity, and offset controls.

### 9.4 Healing brush

A classical local texture/color blending operation. It must be described as an algorithmic retouching tool, not an intelligent repair tool.

---

## 10. Image adjustments

All adjustments must be reversible until committed or flattened.

Required:

- Brightness
- Contrast
- Exposure
- Gamma
- Saturation
- Vibrance
- Hue
- Temperature
- Tint
- Highlights
- Shadows
- Whites
- Blacks
- Levels
- RGB curves
- Grayscale
- Invert
- Sepia
- Color balance

Requirements:

- Slider and numeric entry
- Reset control
- Before/after preview
- Enable/disable adjustment
- Non-destructive adjustment layer or adjustment stack
- Full-resolution application on commit

Use deterministic formulas and lookup tables where useful. Document the expected parameter ranges and clipping behavior.

---

## 11. Filters and effects

Required filters:

- Gaussian blur
- Box blur
- Median blur
- Sharpen
- Unsharp mask
- Edge detection
- Emboss
- Posterize
- Pixelate
- Grayscale
- Sepia
- Negative
- Vignette
- Noise / grain
- Motion blur
- Sobel edge filter

Use convolution kernels for spatial filters. Use separable Gaussian passes when possible. Ensure alpha handling is correct and avoid color fringes around transparent pixels.

All filters need:

- Parameter controls
- Preview
- Apply
- Cancel
- Undo

---

## 12. Layers and masks

Required layer operations:

- Create
- Delete
- Duplicate
- Rename
- Reorder
- Hide / show
- Lock / unlock
- Group / ungroup
- Merge down
- Flatten image
- Opacity
- Blend mode
- Transform
- Add / remove mask

Initial blend modes:

- Normal
- Multiply
- Screen
- Overlay
- Darken
- Lighten
- Soft Light
- Hard Light

Layer masks must use grayscale alpha masks and support non-destructive reveal/hide editing.

---

## 13. Transform and crop tools

Required:

- Move layer
- Scale
- Rotate
- Flip horizontal
- Flip vertical
- Crop
- Canvas resize
- Image resize
- Perspective-free transform in initial release
- Alignment and distribution for supported objects

Keep image resize separate from canvas resize:

- Image resize resamples content.
- Canvas resize changes the document boundary without necessarily resampling layer pixels.

Use clear previews before applying destructive transforms.

---

## 14. Local storage and persistence

PixelPaint must work without a backend. Browser storage is used to preserve user work and preferences.

### 14.1 Storage responsibilities

**IndexedDB — primary storage**
- Project documents
- Layer data
- Original image blobs
- Autosave snapshots
- History checkpoints
- Thumbnails
- Recovery records

**localStorage — small persistent preferences**
- Theme
- Panel visibility
- Last selected tool
- Default brush settings
- Last workspace layout
- Recent document metadata
- User interface preferences

**sessionStorage — temporary session state**
- Current active document ID
- Temporary tool state
- In-progress import metadata
- Session-only recovery hints

**Cache API — optional**
- Only for static application resources if the application is hosted as a PWA.
- Not a replacement for project storage.
- The single-file offline version must not require a service worker or Cache API.

### 14.2 Why not store full images in localStorage?

localStorage stores strings and has small browser-dependent quotas. Base64 encoding increases data size and can cause quota errors or performance problems. Large images and projects must use IndexedDB as Blobs or structured records.

### 14.3 Autosave

- Autosave after meaningful edits using a debounce.
- Do not write the entire document on every pointer-move event.
- Save operation metadata and changed layer data where practical.
- Create periodic recovery checkpoints.
- Show save status: Saved, Saving, or Recovery needed.
- Handle quota errors without crashing.
- Allow the user to clear cached previews and old recovery checkpoints.
- Never delete the only recovery copy without user confirmation.

### 14.4 Browser storage limitations

Browser storage is not guaranteed permanent. Users can clear site data, private browsing may restrict persistence, and browsers may evict data under storage pressure.

Requirements:

- Request persistent storage with `navigator.storage.persist()` when available.
- Check storage quota using `navigator.storage.estimate()` when available.
- Show storage warnings.
- Encourage exporting `.pforge` backups for important projects.
- Never claim that browser storage is a permanent backup.

### 14.5 Recovery

On launch:

1. Load preferences.
2. Inspect IndexedDB for recoverable sessions.
3. If an unfinished session exists, show a recovery prompt.
4. Restore the most recent valid checkpoint.
5. Preserve the original recovery record until restoration succeeds.

---

## 15. Undo, redo, and history

Implement command-based history rather than copying the entire canvas for every small operation.

Each history command should define:

- Command type
- Timestamp
- Target document/layer
- Parameters
- Before state or reversible delta
- After state or reversible delta
- Undo handler
- Redo handler

Examples:

- Brush stroke
- Selection change
- Mask update
- Crop
- Transform
- Filter application
- Layer creation/deletion
- Adjustment change

Use checkpoints for large operations and memory management. Provide configurable history depth and a safe memory limit.

---

## 16. Rendering and performance architecture

### 16.1 Rendering model

Separate:

- Document pixel dimensions
- Viewport dimensions
- Device pixel ratio
- Screen coordinates
- Document coordinates
- Layer-local coordinates

The display canvas is a viewport. It must not become the source of truth for the document.

### 16.2 Canvas architecture

Recommended canvases:

1. Main composite display canvas.
2. Temporary interaction overlay canvas.
3. Optional offscreen layer render canvases.
4. Selection mask canvas or typed-array mask.
5. Preview canvas for filter previews.

### 16.3 CPU processing

Use CPU algorithms for:

- Flood fill
- Color range
- Mask operations
- Pixel-level edits
- Histogram calculations
- Clone and healing operations
- Inpainting if implemented

### 16.4 GPU processing

Use WebGL2 optionally for:

- Brightness and contrast
- Color adjustments
- Convolution filters
- Blur
- Sharpen
- Layer compositing where worthwhile

WebGL2 must be optional. If unavailable or lost, the application falls back to Canvas 2D / CPU algorithms.

### 16.5 Large images

- Use preview resolution while sliders are moving.
- Apply final operations at full document resolution.
- Use tiles for large images where practical.
- Avoid retaining multiple unnecessary full-size copies.
- Release ImageBitmap objects and GPU textures when no longer needed.
- Keep long operations out of the main UI thread when possible.
- Use inline Web Workers created from Blob URLs for CPU-heavy work.
- Provide cancellation for expensive operations where practical.
- Show progress for operations that take noticeable time.

### 16.6 Performance targets

Targets are goals on supported hardware, not universal guarantees:

- Initial editor shell becomes interactive quickly on a modern device.
- Pointer drawing feels immediate.
- Basic selection feedback appears without perceptible delay for ordinary images.
- Common adjustment previews aim for under 100 ms at preview resolution.
- UI remains responsive during expensive processing.
- Undo/redo should not require reloading the document.
- Full-resolution export preserves source dimensions unless the user changes them.

---

## 17. Single-file application architecture

Use clear internal modules even though the application ships as one file.

Suggested JavaScript sections:

1. `PixelPaintConfig`
2. `PixelPaintUtils`
3. `StorageManager`
4. `DocumentManager`
5. `AssetManager`
6. `CoordinateMapper`
7. `CanvasRenderer`
8. `SelectionEngine`
9. `MaskEngine`
10. `ToolManager`
11. `BrushEngine`
12. `PixelProcessing`
13. `AdjustmentEngine`
14. `FilterEngine`
15. `LayerManager`
16. `HistoryManager`
17. `ImportExportManager`
18. `KeyboardManager`
19. `UIController`
20. `AppBootstrap`

Use namespaced objects or ES classes inside the single script. Avoid polluting `window` with many globals. Keep functions small and testable.

### 17.1 Suggested internal data model

```js
const documentModel = {
  id: crypto.randomUUID(),
  schemaVersion: 1,
  name: "Untitled",
  width: 1920,
  height: 1080,
  colorSpace: "sRGB",
  background: null,
  activeLayerId: null,
  layers: [],
  selection: null,
  adjustments: [],
  createdAt: Date.now(),
  updatedAt: Date.now()
};

const layerModel = {
  id: crypto.randomUUID(),
  name: "Background",
  type: "image",
  visible: true,
  locked: false,
  opacity: 1,
  blendMode: "normal",
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0
  },
  assetKey: null,
  maskKey: null
};
```

The model is illustrative. Production code must validate values and separate binary image data from metadata.

### 17.2 Selection model

```js
const selectionState = {
  mode: "replace",
  tool: "freehand-lasso",
  points: [],
  mask: null,
  featherRadius: 0,
  antialias: true,
  active: false
};
```

The actual mask should be stored as a typed array or suitable canvas-backed representation, not as a huge JSON number array.

---

## 18. Core algorithm specifications

### 18.1 Coordinate conversion

All drawing and selection operations must use document coordinates.

Given viewport transform values:

- `zoom`
- `panX`
- `panY`
- `devicePixelRatio`

Convert pointer coordinates into document coordinates using one centralized coordinate mapper. Do not implement separate inconsistent conversions in each tool.

Account for canvas bounding rectangle and CSS scaling.

### 18.2 Freehand path simplification

Use a deterministic path simplification method such as Ramer–Douglas–Peucker or distance-based point reduction.

- Keep the tolerance small.
- Make smoothing optional.
- Preserve corners where possible.
- Never move the path toward an inferred image subject boundary.

### 18.3 Mask feathering

Apply a Gaussian blur to the selection mask only. Feather radius is expressed in document pixels, not screen pixels. Clamp output to 0–255.

### 18.4 Mask morphology

Implement expand/contract with morphological dilation and erosion. For a first version, use a documented square or disk structuring element. Keep the result deterministic.

### 18.5 Alpha compositing

Use correct alpha compositing. Avoid treating transparent RGB values as visible colors. When filtering partially transparent images, consider premultiplied alpha to prevent colored halos.

### 18.6 Flood fill

Use an iterative queue or scanline implementation. Mark visited pixels to avoid repeated work. Support a maximum pixel budget and cancellation to protect memory.

### 18.7 Convolution

For a kernel `K`, compute weighted neighboring pixel values and normalize when appropriate. Handle image boundaries explicitly. Keep alpha behavior documented.

---

## 19. Keyboard shortcuts

Initial shortcut set:

| Action | Shortcut |
|---|---|
| Open | Ctrl/Cmd + O |
| Save project | Ctrl/Cmd + S |
| Export | Ctrl/Cmd + Shift + S |
| Undo | Ctrl/Cmd + Z |
| Redo | Ctrl/Cmd + Y or Ctrl/Cmd + Shift + Z |
| Cut | Ctrl/Cmd + X |
| Copy | Ctrl/Cmd + C |
| Paste | Ctrl/Cmd + V |
| Select all | Ctrl/Cmd + A |
| Deselect | Ctrl/Cmd + D |
| Transform | Ctrl/Cmd + T |
| Brush | B |
| Eraser | E |
| Rectangular selection | M |
| Lasso | L |
| Color picker | I |
| Text | T |
| Zoom | Z |
| Hand / pan | Space |
| Escape current operation | Esc |

Shortcuts must not override normal text entry in input fields or editable text.

---

## 20. Security and privacy

- Process image pixels locally.
- Do not upload user images.
- Do not send telemetry.
- Do not load hidden third-party scripts.
- Sanitize SVG before parsing or rendering.
- Validate imported file types and sizes.
- Avoid unsafe `innerHTML` for user-controlled text.
- Treat project files as untrusted input.
- Validate project schema, asset lengths, dimensions, and layer references.
- Guard against decompression bombs if ZIP-based projects are supported.
- Revoke object URLs when no longer needed.
- Handle browser storage failures safely.

---

## 21. Error handling

Provide clear UI messages for:

- Unsupported image format
- Corrupt image
- Image too large
- Insufficient memory
- Storage quota exceeded
- Project version unsupported
- Project file corrupt
- Export failed
- Clipboard permission denied
- WebGL unavailable or context lost
- Worker creation or processing failure

A failed operation must not silently corrupt the current document. Where possible, preserve the previous state and allow undo or recovery.

---

## 22. Testing strategy

### 22.1 Selection tests

- Trace a simple rectangle with freehand lasso.
- Trace an irregular shape.
- Trace at multiple zoom levels.
- Trace after panning.
- Test pointer cancellation.
- Test add, subtract, and intersect.
- Test antialiasing and feather.
- Test mask inversion and morphology.
- Confirm the selection stays aligned with the image after transforms.

### 22.2 Cutout tests

- Remove outside selection.
- Remove inside selection.
- Copy selection to a new layer.
- Cut selection and undo.
- Export transparent PNG.
- Verify edge alpha values.
- Verify that untouched pixels remain unchanged.

### 22.3 Processing tests

- Brightness and contrast on known pixel fixtures.
- Histogram output.
- Gaussian blur.
- Sharpen.
- Grayscale.
- Color range.
- Flood fill with tolerance.
- Alpha compositing.
- Transparent-edge halo tests.

### 22.4 Persistence tests

- Save and reopen a project.
- Reload browser and recover.
- Simulate quota failure.
- Validate corrupted project handling.
- Verify preferences survive restart.
- Verify session state is temporary.
- Verify no image is sent over the network.

### 22.5 Device tests

- Desktop mouse.
- Laptop trackpad.
- Tablet stylus.
- Tablet touch.
- Phone touch.
- High-DPI display.
- Browser without WebGL2.
- Browser without OffscreenCanvas.

---

## 23. Acceptance criteria

PixelPaint is ready for its first complete release when:

1. The complete app runs from one HTML file.
2. Core editing works offline.
3. No backend is required.
4. No AI or LLM code, model, or API is present.
5. Images can be imported and exported.
6. Freehand lasso records the user's uneven pointer path accurately.
7. The lasso creates an antialiased selection mask.
8. The user can refine the mask manually.
9. Remove Outside produces correct transparency.
10. Copy Selection to New Layer preserves alignment and alpha.
11. Magic Wand and Color Range use deterministic color calculations.
12. Layers and masks can be edited.
13. Adjustments and filters work and can be undone.
14. Autosave and recovery work through browser storage.
15. Large operations do not permanently freeze the interface.
16. CPU fallback works when GPU acceleration is unavailable.
17. The UI supports mouse and touch input.
18. Exported PNG preserves transparency.
19. The user can save a portable editable project.
20. The application never claims AI-style semantic object recognition.

---

## 24. Implementation roadmap

### Phase 1 — Single-file foundation

- Create `PixelPaint.html`.
- Build responsive dark UI.
- Implement document model.
- Implement import and export.
- Implement canvas viewport, zoom, and pan.
- Implement centralized coordinate mapping.

### Phase 2 — Selection and cutout engine

- Implement rectangular and elliptical selections.
- Implement freehand lasso.
- Implement polygon lasso.
- Implement grayscale selection masks.
- Implement selection add/subtract/intersect.
- Implement feather, expand, contract, smooth, and invert.
- Implement remove inside/outside.
- Implement copy selection to new layer.
- Implement manual mask brush.

### Phase 3 — Painting and shapes

- Pencil, brush, eraser, fill, picker.
- Lines, rectangles, ellipses, polygons.
- Text tool.
- Tool settings and shortcuts.

### Phase 4 — Layers and history

- Layer panel and operations.
- Opacity and blend modes.
- Layer masks.
- Command-based undo/redo.
- History panel.

### Phase 5 — Adjustments and filters

- Color adjustments.
- Levels and curves.
- Histogram.
- Blur, sharpen, convolution filters.
- Preview and apply/cancel flow.

### Phase 6 — Classical advanced tools

- Magic Wand.
- Color Range.
- Flood Fill.
- Chroma Key.
- Edge-assisted lasso.
- Clone stamp.
- Healing brush.
- Optional patch-based reconstruction and classical inpainting.

### Phase 7 — Persistence and release hardening

- IndexedDB project persistence.
- localStorage preferences.
- sessionStorage state.
- Autosave and recovery.
- Project import/export.
- Memory and performance limits.
- Browser and touch testing.
- Security review.

---

## 25. Recommended first-release scope

To avoid an enormous first implementation, the first usable release should prioritize:

1. Single HTML file and responsive editor shell.
2. Image import and PNG export.
3. Canvas pan and zoom.
4. Freehand lasso with precise pointer-path recording.
5. Antialiased selection mask.
6. Manual mask reveal/hide brush.
7. Remove outside / remove inside.
8. Copy selection to new layer.
9. Undo and redo.
10. IndexedDB autosave and local preferences.

These capabilities deliver the defining PixelPaint experience. Advanced reconstruction, curves, complex blend modes, and additional filters can follow without compromising the core architecture.

---

## 26. Final product definition

 is a **manual-first, algorithm-driven image editor** packaged as a single HTML file.

Its defining feature is precise user-controlled editing. The user draws the boundary, the application records that path, converts it into a pixel mask, and applies conventional image-processing operations to the selected pixels.

The product must remain transparent about what its algorithms do. Edge detection can follow strong edges; color thresholding can select similar colors; flood fill can select connected regions; masks can preserve partial transparency. None of these techniques understands the semantic meaning of a photograph.

**The user makes the creative decision. PixelPaint provides the precision, tools, and processing power to execute it.**

**Absolute requirement: zero AI, zero LLMs, zero generative models, zero remote inference.**
"""

out = "/mnt/data/PixelPaint_Developer_PRD.md"
pypandoc.convert_text(md, "md", format="md", outputfile=out, extra_args=["--standalone"])
print(out)
