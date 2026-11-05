# xash-1.2.2-512mb.wasm

`dist/xash.wasm` from the npm package **xash3d-fwgs@1.2.2** (Xash3D FWGS engine, https://github.com/FWGS/xash3d-fwgs),
with one change: the wasm memory section's initial and maximum size raised from 4096 to 8192 pages
(256 MB → 512 MB). That build can't grow its memory at runtime, so busy matches crashed with `Aborted(OOM)`.

Only 2 bytes differ from the original:
- original sha256 `1066cca502a5659b668611bc3fe2a867301e30bbe7e3c923891318a66e5ae8f2`
- patched  sha256 `c43cbf696f6924908957eedc7f6d22a03254593fe61468b364897542b91887f3`

Use it in place of `xash.wasm` (the other engine files stay on jsDelivr):
`https://raw.githubusercontent.com/th3nu8/EaglercraftLauncher/main/server/cs16-web/engine/xash-1.2.2-512mb.wasm`
