// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: deep-blue; icon-glyph: utensils;
const TOKEN = "PASTE_TOKEN";
const API_URL = "https://steady-re7n.onrender.com/api/widget/today";
const FOOD_URL = "https://steady-re7n.onrender.com/food";

const SMALL = config.widgetFamily === "small";

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

function whole(value) {
  const n = Number(value);
  return String(Math.round(Number.isFinite(n) ? n : 0));
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

function ringImage(eaten, target, left) {
  const size = 112;
  const line = 8;
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
  const figure = whole(Math.abs(Number(left) || 0));
  draw.setTextAlignedCenter();
  draw.setTextColor(INK);
  draw.setFont(Font.lightSystemFont(figure.length > 3 ? 24 : 28));
  draw.drawTextInRect(figure, new Rect(12, 34, size - 24, 32));
  draw.setTextColor(INK_SOFT);
  draw.setFont(Font.lightSystemFont(11));
  draw.drawTextInRect(over ? "kcal over" : "kcal left", new Rect(8, 64, size - 16, 16));
  return draw.getImage();
}

function barImage(pct, width) {
  const height = 7;
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
    fill.addRoundedRect(new Rect(0, 0, Math.max(height, Math.min(width, width * pct)), height), radius, radius);
    draw.addPath(fill);
    draw.setFillColor(ACCENT);
    draw.fillPath();
  }
  return draw.getImage();
}

function macroRow(stack, label, eaten, target, barWidth) {
  const line = stack.addStack();
  line.layoutHorizontally();
  line.centerAlignContent();
  const name = line.addText(label);
  name.font = Font.lightSystemFont(13);
  name.textColor = TEXT;
  line.addSpacer();
  const had = line.addText(grams(eaten));
  had.font = Font.lightSystemFont(13);
  had.textColor = TEXT;
  const of = line.addText(` / ${grams(target)} g`);
  of.font = Font.lightSystemFont(13);
  of.textColor = MUTED;
  stack.addSpacer(5);
  const bar = stack.addImage(barImage(fraction(eaten, target), barWidth));
  bar.imageSize = new Size(barWidth, 7);
}

function footnote(widget, iso) {
  const note = widget.addText(updatedLine(iso));
  note.font = Font.lightSystemFont(10);
  note.textColor = FOOT;
  note.lineLimit = 1;
}

function renderData(widget, data) {
  const over = Number(data.calories.left) < 0;
  if (SMALL) {
    widget.addSpacer();
    const figure = widget.addText(whole(Math.abs(Number(data.calories.left) || 0)));
    figure.font = Font.lightSystemFont(36);
    figure.textColor = TEXT;
    figure.lineLimit = 1;
    figure.minimumScaleFactor = 0.6;
    const caption = widget.addText(over ? "kcal over" : "kcal left");
    caption.font = Font.lightSystemFont(13);
    caption.textColor = MUTED;
    widget.addSpacer(10);
    macroRow(widget, "Protein", data.protein.eaten, data.protein.target, 124);
    widget.addSpacer();
    footnote(widget, data.updatedAt);
    return;
  }
  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();
  row.spacing = 16;
  const ring = row.addImage(ringImage(data.calories.eaten, data.calories.target, data.calories.left));
  ring.imageSize = new Size(112, 112);
  const macros = row.addStack();
  macros.layoutVertically();
  macros.spacing = 10;
  macros.centerAlignContent();
  macroRow(macros, "Protein", data.protein.eaten, data.protein.target, 164);
  macroRow(macros, "Carbs", data.carbs.eaten, data.carbs.target, 164);
  macroRow(macros, "Fat", data.fat.eaten, data.fat.target, 164);
  widget.addSpacer(8);
  footnote(widget, data.updatedAt);
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
  footnote(widget, null);
}

const widget = new ListWidget();
widget.backgroundColor = CARD;
widget.url = FOOD_URL;
widget.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
widget.setPadding(SMALL ? 12 : 14, 16, 12, 16);

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
    renderData(widget, data);
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
