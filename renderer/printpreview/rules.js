// Which print settings exist, and when - Chrome's own rules, MEASURED from Chrome 15x on this PC (owner 2026-10-15) by reading its print preview's
// settings model for a web page and a PDF file on every printer here (Save as PDF, XPS Writer, Print to PDF, OneNote, the TSC label printer).
// One file, used by the dialog page (window.PrintRules) AND by the main process (require), so what is shown and what is printed never disagree.
//   Copies ............ the printer can make more than one copy (Windows MaximumCopies > 1: TSC, OneNote yes; XPS, Print to PDF, Save as PDF no)
//   Collate ........... with Copies, only when the printer collates (DC_COLLATE) and more than 1 copy is asked for
//   Layout ............ web pages only (a PDF keeps its own pages)
//   Color ............. the printer prints colour (SupportsColor); Save as PDF: never (always colour)
//   Paper size ........ the printer's own paper list, its default selected; not for a PDF file saved as PDF
//   Pages per sheet ... always in Chrome; here not for Save as PDF (printToPDF cannot put pages together)
//   Margins ........... web pages only
//   Quality ........... the printer has more than one resolution
//   Scale ............. not for a PDF file saved as PDF
//   Two-sided ......... the printer can print on both sides (CanDuplex)
//   Headers and footers web pages only, not with Margins = None, not on paper under 1 inch tall (the TSC "Exe Barcode" label is 0.79 in),
//                       never in Restricted Mode (it prints the page's address)
//   Odd / Even pages .. only when the document has more than 1 page
//   "More settings" ... only when there are more than 6 sections (Chrome's MAX_SECTIONS_TO_SHOW; why it sometimes shows and sometimes not)
(function (root) {
  const MIN_HEADER_MICRONS = 25400;   // 1 inch

  function paperOf(dest, s) {
    const list = (dest && dest.caps && dest.caps.papers) || [];
    return list.find((p) => p.name === s.paper) || list.find((p) => p.name === dest.caps.defPaper) || list[0] || null;
  }

  function avail(dest, doc, s, total, restricted) {
    const c = (dest && dest.caps) || {};
    const pdfDest = !!dest && dest.kind === "pdf";
    const paper = paperOf(dest, s);
    const a = {};
    a.copies = (c.copies || 1) > 1;
    a.collate = a.copies && !!c.collate && s.copies > 1;
    a.layout = !doc.pdf;
    a.color = !!c.color;
    a.paper = (c.papers || []).length > 0 && !(doc.pdf && pdfDest);
    a.pps = !pdfDest;
    a.margins = !doc.pdf;
    a.dpi = (c.dpis || []).length > 1;
    a.scale = !(doc.pdf && pdfDest);
    a.duplex = !!c.duplex;
    const height = paper ? (s.landscape && !doc.pdf ? paper.w : paper.h) : Infinity;
    a.headers = !doc.pdf && !restricted && height >= MIN_HEADER_MICRONS && s.margins !== "none";
    a.background = !doc.pdf;
    a.options = a.headers || a.background;
    a.oddEven = total > 1;
    const sections = 2 + [a.copies, a.layout, a.color, a.paper, a.margins, a.pps, a.scale, a.dpi, a.options].filter(Boolean).length;   // + Destination, Pages
    a.moreToggle = sections > 6;
    return a;
  }

  const api = { avail, paperOf, MIN_HEADER_MICRONS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PrintRules = api;
})(this);
