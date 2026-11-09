# Vendored libraries (self-hosted; nothing loads from a CDN)

| Folder | Version | Source (exact URL) | npm integrity (sha512) | Licence |
|---|---|---|---|---|
| `three-0.169.0/` | three 0.169.0 | https://registry.npmjs.org/three/-/three-0.169.0.tgz | `Ed906MA3dR4TS5riErd4QBsRGPcx+HBDX2O5yYE5GqJeFQTPU+M56Va/f/Oph9X7uZo3W3o4l2ZhBZ6f6qUv0w==` | MIT (`three-0.169.0/LICENSE`) |
| `meshoptimizer-0.25.0/` | meshoptimizer 0.25.0 | https://registry.npmjs.org/meshoptimizer/-/meshoptimizer-0.25.0.tgz | `ewwuAo3ujPZ7T3Y2oTkEoLlXvNOqnr0cjyAxfv5djXJqwD9QlxDDO0qGtsqB4Z9QUVvhruKXg9q/xfK9I5S1xQ==` | MIT (`meshoptimizer-0.25.0/LICENSE.md`) |

Both tarballs were checked against the registry's integrity hash before extraction (2026-10-14).

## Files taken from three 0.169.0 (paths inside the npm package)
| Here | Package path | Licence |
|---|---|---|
| `three-0.169.0/three.module.min.js` | `build/three.module.min.js` | MIT |
| `three-0.169.0/addons/loaders/GLTFLoader.js` | `examples/jsm/loaders/GLTFLoader.js` | MIT |
| `three-0.169.0/addons/loaders/KTX2Loader.js` | `examples/jsm/loaders/KTX2Loader.js` | MIT |
| `three-0.169.0/addons/utils/BufferGeometryUtils.js` | `examples/jsm/utils/BufferGeometryUtils.js` | MIT |
| `three-0.169.0/addons/utils/WorkerPool.js` | `examples/jsm/utils/WorkerPool.js` | MIT |
| `three-0.169.0/addons/libs/ktx-parse.module.js` | `examples/jsm/libs/ktx-parse.module.js` | MIT (ktx-parse, Don McCurdy) |
| `three-0.169.0/addons/libs/zstddec.module.js` | `examples/jsm/libs/zstddec.module.js` | MIT (zstddec, Don McCurdy; wraps Zstandard, BSD) |
| `three-0.169.0/addons/libs/basis/basis_transcoder.{js,wasm}`, `README.md` | `examples/jsm/libs/basis/` | Apache 2.0 (Basis Universal, Binomial LLC) |

The addons are unmodified. They import the bare specifier `three`, so every page that loads them declares an import
map (docs/v3/engine-api.md, section 1).

## meshoptimizer 0.25.0
`meshoptimizer-0.25.0/meshopt_decoder.module.js` is the package's `meshopt_decoder.module.js` (the decoder for
`EXT_meshopt_compression`, with its WebAssembly inlined). It decodes both vertex codec versions, so models from
current gltfpack or glTF-Transform load.

## Loaded only when needed
- The KTX2 loader, zstddec, ktx-parse and the Basis transcoder load only if a model or material references a KTX2
  texture (the transcoder alone is 204 KB brotli; see the S2 numbers in the engine report).
