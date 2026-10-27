// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: utensils;
const TOKEN = "PASTE_TOKEN";
const API_URL = "https://steady-re7n.onrender.com/api/widget/today";
const FOOD_URL = "https://steady-re7n.onrender.com/food";

const SMALL = config.widgetFamily === "small";
const PAD = 16;

function tone(light, dark) {
  return Device.isUsingDarkAppearance() ? new Color(dark) : new Color(light);
}

const ACCENT = tone("#1f5fd6", "#8eb6ff");
const TRACK = tone("#e6edf5", "#243140");
const INK = tone("#1a2332", "#e7eef6");
const INK_SOFT = tone("#6d7c8f", "#8b9bb0");
const TEXT = Color.dynamic(new Color("#1a2332"), new Color("#e7eef6"));
const MUTED = Color.dynamic(new Color("#6d7c8f"), new Color("#8b9bb0"));
const FOOT = Color.dynamic(new Color("#8a97a8"), new Color("#7d8b9c"));
const CARD = Color.dynamic(new Color("#ffffff"), new Color("#0e141b"));

// screen width, screen height, small, medium width, medium height.
// Published iPhone widget sizes. Later phones reuse the nearest published
// size so a guess cannot draw past the real widget.
const PHONE_WIDGETS = [
  [320, 568, 141, 292, 141],
  [360, 780, 155, 329, 155],
  [375, 667, 148, 321, 148],
  [375, 812, 155, 329, 155],
  [390, 844, 158, 338, 158],
  [393, 852, 158, 338, 158],
  [402, 874, 158, 338, 158],
  [414, 736, 159, 348, 157],
  [414, 896, 169, 360, 169],
  [420, 912, 169, 360, 169],
  [428, 926, 170, 364, 170],
  [430, 932, 170, 364, 170],
  [440, 956, 170, 364, 170],
];

function widgetPoints(family) {
  let width = 393;
  let height = 852;
  try {
    const screen = Device.screenSize();
    width = Math.round(Math.min(screen.width, screen.height));
    height = Math.round(Math.max(screen.width, screen.height));
  } catch {
    // Keep the common 393pt size when the screen size is unavailable.
  }
  let best = PHONE_WIDGETS[0];
  let bestDist = Infinity;
  for (const row of PHONE_WIDGETS) {
    const dist = Math.abs(row[0] - width) + Math.abs(row[1] - height);
    if (dist < bestDist) {
      best = row;
      bestDist = dist;
    }
  }
  if (family === "small") return { width: best[2], height: best[2] };
  return { width: best[3], height: best[4] };
}

function grouped(value) {
  const n = Math.round(Math.abs(Number(value) || 0));
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function grams(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  const rounded = Math.round(n * 10) / 10;
  return Math.abs(rounded - Math.round(rounded)) < 0.001 ? String(Math.round(rounded)) : rounded.toFixed(1);
}

function fraction(eaten, target) {
  const have = Number(eaten);
  const goal = Number(target);
  if (!(goal > 0) || !Number.isFinite(have)) return 0;
  return Math.max(0, Math.min(1, have / goal));
}

function updatedLine(iso) {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return "Updated —";
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const suffix = hours >= 12 ? "PM" : "AM";
  hours = hours % 12 || 12;
  return `Updated ${hours}:${minutes} ${suffix}`;
}

function strokeArc(draw, cx, cy, radius, start, sweep, color, width) {
  const steps = Math.max(8, Math.ceil((Math.abs(sweep) * 180) / Math.PI / 3));
  const path = new Path();
  for (let i = 0; i <= steps; i++) {
    const angle = start + (sweep * i) / steps;
    const point = new Point(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
    if (i === 0) path.move(point);
    else path.addLine(point);
  }
  draw.addPath(path);
  draw.setStrokeColor(color);
  draw.setLineWidth(width);
  draw.strokePath();
  cap(draw, cx + radius * Math.cos(start), cy + radius * Math.sin(start), width, color);
  cap(draw, cx + radius * Math.cos(start + sweep), cy + radius * Math.sin(start + sweep), width, color);
}

function cap(draw, x, y, width, color) {
  draw.setFillColor(color);
  draw.fillEllipse(new Rect(x - width / 2, y - width / 2, width, width));
}

function ringImage(eaten, target, left, size) {
  const line = size >= 100 ? 8 : 7;
  const draw = new DrawContext();
  draw.size = new Size(size, size);
  draw.respectScreenScale = true;
  draw.opaque = false;
  const rect = new Rect(line / 2, line / 2, size - line, size - line);
  draw.setLineWidth(line);
  draw.setStrokeColor(TRACK);
  draw.strokeEllipse(rect);
  const pct = fraction(eaten, target);
  const radius = (size - line) / 2;
  if (pct >= 0.999) {
    draw.setStrokeColor(ACCENT);
    draw.strokeEllipse(rect);
  } else if (pct > 0) {
    strokeArc(draw, size / 2, size / 2, radius, -Math.PI / 2, pct * Math.PI * 2, ACCENT, line);
  }
  const over = Number(left) < 0;
  const figure = grouped(left);
  const numberSize = figure.length >= 6 ? 20 : figure.length >= 5 ? 23 : 28;
  const caption = over ? "kcal over" : "kcal left";
  const numberH = numberSize + 2;
  const captionH = 14;
  const top = Math.round((size - numberH - captionH) / 2) + 2;
  draw.setTextAlignedCenter();
  draw.setTextColor(INK);
  draw.setFont(Font.lightSystemFont(numberSize));
  draw.drawTextInRect(figure, new Rect(10, top, size - 20, numberH));
  draw.setTextColor(INK_SOFT);
  draw.setFont(Font.lightSystemFont(11));
  draw.drawTextInRect(caption, new Rect(6, top + numberH - 1, size - 12, captionH));
  return draw.getImage();
}

function barImage(pct, width) {
  const height = 6;
  const draw = new DrawContext();
  draw.size = new Size(width, height);
  draw.respectScreenScale = true;
  draw.opaque = false;
  const radius = height / 2;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, width, height), radius, radius);
  draw.addPath(track);
  draw.setFillColor(TRACK);
  draw.fillPath();
  if (pct > 0) {
    const fill = new Path();
    const fillWidth = Math.max(height, Math.min(width, width * pct));
    fill.addRoundedRect(new Rect(0, 0, fillWidth, height), radius, radius);
    draw.addPath(fill);
    draw.setFillColor(ACCENT);
    draw.fillPath();
  }
  return draw.getImage();
}

function macroGroup(parent, label, eaten, target, width, tight) {
  const group = parent.addStack();
  group.layoutVertically();
  group.spacing = tight;
  group.size = new Size(width, 0);

  const line = group.addStack();
  line.layoutHorizontally();
  line.centerAlignContent();
  line.size = new Size(width, 0);
  const name = line.addText(label);
  name.font = Font.lightSystemFont(13);
  name.textColor = TEXT;
  name.lineLimit = 1;
  name.minimumScaleFactor = 0.75;
  line.addSpacer();
  const had = line.addText(grams(eaten));
  had.font = Font.lightSystemFont(13);
  had.textColor = TEXT;
  had.lineLimit = 1;
  had.minimumScaleFactor = 0.75;
  const rest = line.addText(` / ${grams(target)} g`);
  rest.font = Font.lightSystemFont(13);
  rest.textColor = MUTED;
  rest.lineLimit = 1;
  rest.minimumScaleFactor = 0.75;

  const bar = group.addImage(barImage(fraction(eaten, target), width));
  bar.imageSize = new Size(width, 6);
}

function footnote(parent, iso, center) {
  const note = parent.addText(updatedLine(iso));
  note.font = Font.lightSystemFont(10);
  note.textColor = FOOT;
  note.lineLimit = 1;
  note.minimumScaleFactor = 0.7;
  if (center) note.centerAlignText();
  return note;
}

function renderMedium(widget, data) {
  const bounds = widgetPoints("medium");
  const innerW = bounds.width - PAD * 2;
  const innerH = bounds.height - PAD * 2;
  const footGap = 3;
  const footLine = 13;
  const ring = Math.min(108, innerH - footGap - footLine - 2);
  const columnGap = 12;
  const colW = Math.floor(innerW - ring - columnGap);
  const tight = 6;
  const groupH = 18 + tight + 6;
  let between = 11;
  if (groupH * 3 + between * 2 > innerH) {
    between = Math.max(8, Math.floor((innerH - groupH * 3) / 2));
  }

  widget.addSpacer();
  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  row.spacing = columnGap;
  row.size = new Size(innerW, 0);

  const left = row.addStack();
  left.layoutVertically();
  left.spacing = footGap;
  left.size = new Size(ring, 0);
  left.centerAlignContent();
  const ringView = left.addImage(ringImage(data.calories.eaten, data.calories.target, data.calories.left, ring));
  ringView.imageSize = new Size(ring, ring);
  footnote(left, data.updatedAt, true);

  const macros = row.addStack();
  macros.layoutVertically();
  macros.spacing = between;
  macros.size = new Size(colW, 0);
  macros.centerAlignContent();
  macroGroup(macros, "Protein", data.protein.eaten, data.protein.target, colW, tight);
  macroGroup(macros, "Carbs", data.carbs.eaten, data.carbs.target, colW, tight);
  macroGroup(macros, "Fat", data.fat.eaten, data.fat.target, colW, tight);
  widget.addSpacer();
}

function renderSmall(widget, data) {
  const bounds = widgetPoints("small");
  const innerW = Math.floor(bounds.width - PAD * 2);
  const innerH = bounds.height - PAD * 2;
  const over = Number(data.calories.left) < 0;
  const numberSize = innerH >= 120 ? 34 : innerH >= 112 ? 28 : 26;
  const gap = innerH >= 120 ? 6 : 4;
  widget.addSpacer();
  const figure = widget.addText(grouped(data.calories.left));
  figure.font = Font.lightSystemFont(numberSize);
  figure.textColor = TEXT;
  figure.lineLimit = 1;
  figure.minimumScaleFactor = 0.6;
  const caption = widget.addText(over ? "kcal over" : "kcal left");
  caption.font = Font.lightSystemFont(13);
  caption.textColor = MUTED;
  widget.addSpacer(gap);
  macroGroup(widget, "Protein", data.protein.eaten, data.protein.target, innerW, 6);
  widget.addSpacer(gap);
  footnote(widget, data.updatedAt, false);
  widget.addSpacer();
}

function renderError(widget, message) {
  widget.addSpacer();
  const title = widget.addText("Steady");
  title.font = Font.lightSystemFont(12);
  title.textColor = MUTED;
  widget.addSpacer(4);
  const body = widget.addText(message);
  body.font = Font.lightSystemFont(15);
  body.textColor = TEXT;
  body.lineLimit = 3;
  widget.addSpacer();
  footnote(widget, null, false);
  widget.addSpacer();
}

const widget = new ListWidget();
widget.backgroundColor = CARD;
widget.url = FOOD_URL;
function civilToday() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function nextLocalMidnight() {
  const next = new Date();
  next.setHours(24, 0, 0, 0);
  return next;
}

function asThisDay(data) {
  if (!data || !data.date || data.date === civilToday()) return data;
  return {
    ...data,
    date: civilToday(),
    calories: { eaten: 0, target: data.calories.target, left: data.calories.target },
    protein: { eaten: 0, target: data.protein.target },
    carbs: { eaten: 0, target: data.carbs.target },
    fat: { eaten: 0, target: data.fat.target },
  };
}

const quarterHour = new Date(Date.now() + 15 * 60 * 1000);
const midnight = nextLocalMidnight();
widget.refreshAfterDate = quarterHour < midnight ? quarterHour : midnight;
widget.spacing = 0;
widget.setPadding(PAD, PAD, PAD, PAD);

if (!TOKEN || TOKEN === "PASTE_TOKEN") {
  renderError(widget, "Paste WIDGET_TOKEN into the script.");
} else {
  try {
    const request = new Request(`${API_URL}?t=${Date.now()}`);
    request.headers = { Authorization: `Bearer ${TOKEN}`, "Cache-Control": "no-cache" };
    request.timeoutInterval = 20;
    const data = await request.loadJSON();
    const status = request.response?.statusCode ?? 0;
    if (status !== 200 || !data || data.calories == null || data.protein == null) {
      throw new Error("refresh failed");
    }
    const today = asThisDay(data);
    if (SMALL) renderSmall(widget, today);
    else renderMedium(widget, today);
  } catch {
    renderError(widget, "Couldn't refresh today.");
  }
}

if (config.runsInWidget) {
  Script.setWidget(widget);
} else if (SMALL) {
  widget.presentSmall();
} else {
  widget.presentMedium();
}
Script.complete();
