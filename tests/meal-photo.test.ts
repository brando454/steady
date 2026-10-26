import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const photo = fs.readFileSync(new URL("../ios/Steady/MealPhoto.swift", import.meta.url), "utf8");
const food = fs.readFileSync(new URL("../ios/Steady/FoodView.swift", import.meta.url), "utf8");
const model = fs.readFileSync(new URL("../ios/Steady/AppModel.swift", import.meta.url), "utf8");
const plist = fs.readFileSync(new URL("../ios/Steady/Info.plist", import.meta.url), "utf8");
const web = fs.readFileSync(new URL("../src/client/screens/Food.tsx", import.meta.url), "utf8");
const thumb = fs.readFileSync(new URL("../src/server/util.ts", import.meta.url), "utf8");

function constant(name: string): string {
  const match = photo.match(new RegExp(`static let ${name}[^=]*=\\s*([^\\n]+)`));
  assert.ok(match, name);
  return match[1].replace(/\/\/.*$/, "").trim();
}

test("the iPhone photo uses the same jpeg sizes as the site", () => {
  assert.equal(constant("aiEdge"), "1024");
  assert.equal(constant("aiQuality"), "0.8");
  assert.equal(constant("thumbEdge"), "480");
  assert.equal(constant("thumbQuality"), "0.6");
  assert.equal(constant("tightEdge"), "360");
  assert.equal(constant("tightQuality"), "0.5");
  assert.equal(constant("maxThumbCharacters"), "120_000");
  assert.equal(constant("maxEstimateCharacters"), "4_000_000");
  assert.equal(constant("jpegPrefix"), '"data:image/jpeg;base64,"');
  assert.match(web, /compressImage\(file, 1024, 0\.8\)/);
  assert.match(web, /compressImage\(file, 480, 0\.6\)/);
  assert.match(web, /compressImage\(file, 360, 0\.5\)/);
  assert.match(web, /120_000/);
  assert.match(thumb, /data:image\/jpeg;base64,/);
  assert.match(thumb, /120_000/);
  assert.match(photo, /preview == nil/);
  assert.match(photo, /tightEdge/);
});

test("a thumbnail over the limit is dropped, and a smaller one is kept", () => {
  const max = 120_000;
  function stored(wide: number, tight: number): "wide" | "tight" | null {
    if (wide <= max) return "wide";
    if (tight <= max) return "tight";
    return null;
  }
  assert.equal(stored(80_000, 40_000), "wide");
  assert.equal(stored(130_000, 90_000), "tight");
  assert.equal(stored(130_000, 130_000), null);
});

test("Food can take or choose a photo, preview it, and estimate before logging", () => {
  assert.match(food, /Take photo/);
  assert.match(food, /Choose photo/);
  assert.match(food, /Remove photo/);
  assert.match(food, /Estimating…/);
  assert.match(food, /imageDataUrl: image/);
  assert.match(food, /draft\.photo = prepared\.preview/);
  assert.match(food, /estimateImage = prepared\.estimate/);
  assert.match(food, /AppModel\.offlineEstimate/);
  assert.match(food, /UIImagePickerController\.isSourceTypeAvailable\(\.camera\)/);
  assert.match(plist, /NSCameraUsageDescription/);
  assert.match(plist, /NSPhotoLibraryUsageDescription/);
  assert.match(model, /static let offlineEstimate/);
  assert.match(model, /Enter the meal yourself/);
  assert.match(model, /saves it on this phone/);
  assert.match(model, /queue\(method: "POST", path: "\/api\/meals", body: body\)/);
});
