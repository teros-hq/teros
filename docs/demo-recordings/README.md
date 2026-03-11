# Demo Recordings

Animated GIFs of the Teros landing page demo section (`DemoReplaySection`), used in the GitHub README and documentation.

## Files

| File | Demo case | Size |
|------|-----------|------|
| `demo-briefing.gif` | Daily Briefing — Iria checks emails, calendar & tasks | ~203 KB |
| `demo-developer.gif` | Dev Workflow — Nua reads Sentry errors & creates Linear issues | ~205 KB |
| `demo-research.gif` | Research — Vera searches with Perplexity & saves to Notion | ~197 KB |
| `demo-creator.gif` | Content — Rai generates images with FLUX & uploads to Drive | ~207 KB |

---

## How to re-record

These GIFs are captured from the live landing at **https://teros.ai** using Playwright + ffmpeg.

### Requirements

- Node.js with Playwright installed
- ffmpeg (`apt install ffmpeg` or `brew install ffmpeg`)

### Recording parameters

| Parameter | Value |
|-----------|-------|
| URL | `https://teros.ai` |
| Viewport | `1280 × 1200` |
| Clip X | `241` |
| Clip Y | `560` |
| Clip Width | `798` |
| Clip Height | `601` |
| Framerate | `6 fps` |
| Frame interval | `167 ms` |
| Total frames | `150` (~25 seconds) |
| GIF colors | `256` |
| Dither | `bayer` |

> The clip captures only the mock browser window (`os.teros.ai`) with ~15px of uniform padding on all sides.

### Step-by-step

#### 1. Capture frames with Playwright

```js
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.goto('https://teros.ai');

  // Scroll to demo section
  await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('*'));
    for (const el of elements) {
      if (el.textContent?.trim() === 'os.teros.ai') {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        break;
      }
    }
  });

  await page.waitForTimeout(2000); // wait for animation to start

  const clip = { x: 241, y: 560, width: 798, height: 601 };

  // Tab coordinates (center of each tab button)
  const tabs = [
    { name: 'briefing',  x: 473.5, y: 519 },
    { name: 'developer', x: 607,   y: 519 },
    { name: 'research',  x: 726.5, y: 519 },
    { name: 'creator',   x: 825.5, y: 519 },
  ];

  for (const tab of tabs) {
    fs.mkdirSync(`frames/${tab.name}`, { recursive: true });

    await page.mouse.click(tab.x, tab.y);
    await page.waitForTimeout(2000); // wait for animation to reset

    for (let i = 0; i < 150; i++) {
      await page.screenshot({
        path: `frames/${tab.name}/frame_${String(i).padStart(4, '0')}.png`,
        clip,
      });
      await page.waitForTimeout(167);
    }

    console.log(`✓ ${tab.name} captured`);
  }

  await browser.close();
})();
```

#### 2. Convert frames to GIF with ffmpeg

```bash
for tab in briefing developer research creator; do
  ffmpeg -y -framerate 6 -i frames/${tab}/frame_%04d.png \
    -vf "fps=6,scale=798:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=bayer" \
    docs/demo-recordings/demo-${tab}.gif
  echo "✓ demo-${tab}.gif"
done
```

---

## Notes

- The `DemoReplaySection` animation starts automatically when the section enters the viewport (`IntersectionObserver` with `threshold: 0.1`).
- Each demo case loops indefinitely with a 9-second pause between cycles.
- If the landing layout changes (e.g. section reordered or resized), re-measure the clip coordinates by inspecting the element containing `os.teros.ai` in the browser DevTools.
