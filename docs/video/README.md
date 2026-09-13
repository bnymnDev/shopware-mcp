# Intro video

`index.html` is a [HyperFrames](https://github.com/heygen-com/hyperframes) composition: an HTML file whose
timing lives in `data-*` attributes and one paused GSAP timeline, rendered to MP4 by a headless browser and
FFmpeg. Thirty seconds, 1920×1080, five scenes: the name, a real `shop_audit` answer, the numbers, the safety
model, and how to install. The audit lines are the same real output as `docs/demo/audit.json`.

Render it (Node 22 and FFmpeg on the PATH):

```bash
cd docs/video
npx hyperframes@0.8.36 check                      # lint, runtime, layout and contrast audits
npx hyperframes@0.8.36 render --quality high --output shopware-mcp-intro.mp4
```

The MP4 is not committed; it is attached to release announcements instead. Text and timings are plain HTML,
so a new scene is a new `<section class="clip" data-start data-duration>` plus its tweens at the bottom.
