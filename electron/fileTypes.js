// Which local files PBCalc opens in a TAB itself (instead of leaving them to another program), in two strengths.
//
// IN_TAB   - what a finished download opens as when clicked in the Downloads list (downloadManager.open): PDFs, images and
//            plain text. Deliberately NOT html / svg (a downloaded page would run its scripts at once) and NOT csv / md
//            (Chromium turns those into a download again, so they would loop back into the list).
// FROM_USER - what the USER hands PBCalc themselves: a file dropped on the window, or one Windows passes when PBCalc is the
//            chosen app. Chrome opens web pages and svg there too, so these are added.
const IMAGES = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif"];
const TEXT = [".txt", ".log", ".json"];
const PDF = [".pdf"];
const WEB = [".html", ".htm", ".xhtml", ".svg"];
// Video: Chrome plays these in its own player page (controls, full screen, speed, download). Chromium shows a local video file
// that way, so no script of the file ever runs (unlike html / svg).
const VIDEO = [".mp4", ".webm", ".m4v", ".ogv", ".mov"];

const IN_TAB = new Set([...PDF, ...IMAGES, ...TEXT, ...VIDEO]);
const FROM_USER = new Set([...IN_TAB, ...WEB]);

// "pdf" | "html" | "image" | "text" | null - which of PBCalc's file icons / ProgIds a file belongs to
function kindOf(ext) {
  const e = String(ext || "").toLowerCase();
  if (PDF.includes(e)) return "pdf";
  if ([".html", ".htm", ".xhtml"].includes(e)) return "html";
  if (IMAGES.includes(e) || e === ".svg") return "image";
  if (TEXT.includes(e)) return "text";
  return null;
}

module.exports = { IN_TAB, FROM_USER, TEXT, PDF, VIDEO, kindOf };
