/*!
 * NASC SPORTS - A4 PDF generation (report + certificate)
 * Uses locally vendored jsPDF + autotable (public/vendor/) so it works offline
 * inside the PWA / Capacitor app. No screenshots: PDF is built from real
 * structured text and tables (selectable / searchable).
 *
 * Exposed API (window.NascPDF):
 *   previewReport()        -> open on-screen preview modal (select AY first)
 *   printReport()          -> open browser print dialog for generated PDF
 *   downloadReport()       -> save Sports_Achievement_Report_<AY>.pdf
 *   previewCertificate(id)
 *   printCertificate(id)
 *   downloadCertificate(id)
 *   closePreview()
 */
(function () {
  "use strict";

  var jsPDF = window.jspdf && window.jspdf.jsPDF;
  var GState = window.jspdf && (window.jspdf.GState || jsPDF && jsPDF.GState);

  // ---- Config ---------------------------------------------------------------
  var INSTITUTION_NAME = "NASC SPORTS";
  var DEPT_LINE = "Department of Sports & Physical Education";
  var DEPT_NAME = "Sports Department";
  var COLORS = {
    navy: [11, 18, 32],
    gold: [185, 146, 75],
    ink: [31, 41, 55],
    muted: [102, 112, 133],
    light: [245, 246, 249],
    line: [196, 201, 210],
  };
  var P = { w: 210, h: 297, m: 12 }; // A4 portrait, mm
  var FONT_LATIN = "Montserrat";
  var FONT_IND = "NotoDv"; // Noto Sans Devanagari (covers Indic scripts + basic Latin)

  var PDF_STATE = { ready: null, fonts: null, blobUrl: null, filename: "", doc: null };
  var INDIC_RE = /[\u0900-\u0DFF\u0E00-\u0E7F\u0C80-\u0CFF\u0D00-\u0DFF\u0B80-\u0BFF\u0A80-\u0AFF\u0980-\u09FF]/;

  // ---- Font bootstrapping ---------------------------------------------------
  function toBase64(buf) {
    var bin = "", chunk = 0x8000, bytes = new Uint8Array(buf);
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }
  function loadFontBase64(url) {
    return fetch(url, { cache: "reload" })
      .then(function (r) { if (!r.ok) throw new Error("Font fetch failed: " + url); return r.arrayBuffer(); })
      .then(toBase64);
  }
  function hasIndic(text) { return INDIC_RE.test(String(text || "")); }
  function fontFor(text) { return hasIndic(text) ? FONT_IND : FONT_LATIN; }

  function ensureFonts() {
    if (PDF_STATE.ready) return PDF_STATE.ready;
    PDF_STATE.ready = Promise.all([
      loadFontBase64("./vendor/Montserrat-Regular.ttf"),
      loadFontBase64("./vendor/Montserrat-Bold.ttf"),
      loadFontBase64("./vendor/NotoSansDevanagari-Regular.ttf"),
      loadFontBase64("./vendor/NotoSansDevanagari-Bold.ttf"),
    ]).then(function (arr) {
      PDF_STATE.fonts = { mReg: arr[0], mBold: arr[1], dReg: arr[2], dBold: arr[3] };
    });
    return PDF_STATE.ready;
  }
  function registerFonts(doc) {
    var f = PDF_STATE.fonts;
    doc.addFileToVFS("Montserrat-Regular.ttf", f.mReg);
    doc.addFileToVFS("Montserrat-Bold.ttf", f.mBold);
    doc.addFileToVFS("NotoSansDevanagari-Regular.ttf", f.dReg);
    doc.addFileToVFS("NotoSansDevanagari-Bold.ttf", f.dBold);
    doc.addFont("Montserrat-Regular.ttf", FONT_LATIN, "normal");
    doc.addFont("Montserrat-Bold.ttf", FONT_LATIN, "bold");
    doc.addFont("NotoSansDevanagari-Regular.ttf", FONT_IND, "normal");
    doc.addFont("NotoSansDevanagari-Bold.ttf", FONT_IND, "bold");
  }

  // ---- Shared helpers -------------------------------------------------------
  function pickFont(font, text) { return hasIndic(text) ? FONT_IND : font; }
  function textWidth(doc, text, font, style) {
    font = font || FONT_LATIN;
    style = style || "normal";
    var o = doc.getFont();
    doc.setFont(pickFont(font, text), style);
    var w = doc.getTextWidth(String(text));
    doc.setFont(o.fontName, o.fontStyle || "normal");
    return w;
  }
  // Draw text; shrink font size until it fits maxWidth (handles long names).
  function drawFitText(doc, text, x, y, maxWidth, opts) {
    opts = opts || {};
    var font = opts.font || FONT_LATIN;
    var size = opts.size || 10;
    var bold = opts.bold !== false;
    var halign = opts.halign || "left";
    var style = bold ? "bold" : "normal";
    var s = size;
    while (s > size * 0.6 && textWidth(doc, text, font, style) > maxWidth) s -= 0.5;
    doc.setFont(pickFont(font, text), style);
    doc.setFontSize(s);
    doc.text(String(text), x, y, { align: halign });
    return s;
  }
  function fmtDateIndia(d) {
    return (d || new Date()).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
  }
  function drawLogo(doc, x, y, size) {
    doc.setFillColor.apply(doc, COLORS.navy);
    doc.roundedRect(x, y, size, size, size * 0.28, size * 0.28, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont(FONT_LATIN, "bold");
    doc.setFontSize(size * 0.55);
    doc.text("N", x + size / 2, y + size / 2 + size * 0.18, { align: "center" });
  }
  function drawDivider(doc, y, x1, x2) {
    doc.setDrawColor.apply(doc, COLORS.gold);
    doc.setLineWidth(0.6);
    doc.line(x1, y, x2, y);
    doc.setDrawColor.apply(doc, COLORS.line);
    doc.setLineWidth(0.2);
  }
  function academicYear() {
    return typeof state !== "undefined" && state.rptYear ? state.rptYear : "";
  }

  // ---- Report page furniture ------------------------------------------------
  function drawReportHeader(doc) {
    var center = P.w / 2, y = P.m;
    drawLogo(doc, center - 7.5, y, 15);
    y += 19;
    doc.setTextColor.apply(doc, COLORS.navy);
    doc.setFont(FONT_LATIN, "bold");
    doc.setFontSize(17);
    doc.text(INSTITUTION_NAME, center, y, { align: "center" });
    y += 6.5;
    doc.setTextColor.apply(doc, COLORS.muted);
    doc.setFont(FONT_LATIN, "normal");
    doc.setFontSize(9);
    doc.text(DEPT_LINE, center, y, { align: "center" });
    y += 6;
    doc.setTextColor.apply(doc, COLORS.navy);
    doc.setFont(FONT_LATIN, "bold");
    doc.setFontSize(14);
    doc.text("SPORTS ACHIEVEMENT REPORT", center, y, { align: "center" });
    y += 5.5;
    doc.setTextColor.apply(doc, COLORS.gold);
    doc.setFont(FONT_LATIN, "bold");
    doc.setFontSize(9.5);
    doc.text("Academic Year: " + academicYear(), center, y, { align: "center" });
    y += 4;
    drawDivider(doc, y, P.m, P.w - P.m);
    return y;
  }
  function drawReportFooter(doc, pageNo, totalPages) {
    var y0 = P.h - P.m;
    doc.setDrawColor(230, 232, 236);
    doc.setLineWidth(0.25);
    doc.line(P.m, y0 - 1.5, P.w - P.m, y0 - 1.5);
    doc.setTextColor.apply(doc, COLORS.muted);
    doc.setFont(FONT_LATIN, "normal");
    doc.setFontSize(8);
    doc.setFont(pickFont(FONT_LATIN, academicYear()), "normal");
    doc.text("Academic Year: " + (academicYear() || "-"), P.m, y0);
    doc.text("Generated On: " + fmtDateIndia(), P.w / 2, y0, { align: "center" });
    doc.text("Page " + pageNo + " of " + totalPages, P.w - P.m, y0, { align: "right" });
    doc.setFont(FONT_LATIN, "bold");
    doc.text(DEPT_NAME + " \u00b7 " + INSTITUTION_NAME, P.m, y0 + 4.5);
  }

  // ---- Summary cards --------------------------------------------------------
  function reportStats(list) {
    var students = {}, team = 0, indiv = 0, interC = 0, stateC = 0, nat = 0, intl = 0;
    list.forEach(function (a) {
      if (a.student_name) students[String(a.student_name).trim().toLowerCase()] = 1;
      var t = String(a.team_individual || "").trim();
      if (t === "Team") team++; else if (t === "Individual") indiv++;
      var lv = String(a.level || "").trim();
      if (/inter-(university|college)/i.test(lv)) interC++;
      else if (/international/i.test(lv)) intl++;
      else if (/national/i.test(lv)) nat++;
      else if (/state/i.test(lv)) stateC++;
    });
    return {
      total: list.length,
      students: Object.keys(students).length,
      team: team,
      indiv: indiv,
      inter: interC,
      state: stateC,
      national: nat,
      international: intl,
    };
  }
  function drawSummary(doc, y) {
    var stats = reportStats(typeof reportFilteredList === "function" ? reportFilteredList() : []);
    var cards = [
      ["Total Achievements", stats.total],
      ["Total Students", stats.students],
      ["Team Achievements", stats.team],
      ["Individual Achievements", stats.indiv],
      ["Inter-University", stats.inter],
      ["State", stats.state],
      ["National", stats.national],
      ["International", stats.international],
    ];
    var left = P.m, right = P.w - P.m, gap = 3;
    var cellW = (right - left - gap * 3) / 4, cellH = 14;
    doc.setTextColor.apply(doc, COLORS.navy);
    doc.setFont(FONT_LATIN, "bold");
    doc.setFontSize(9);
    doc.text("REPORT SUMMARY", left, y);
    y += 4;
    cards.forEach(function (c, i) {
      var col = i % 4, row = Math.floor(i / 4);
      var x = left + col * (cellW + gap);
      var cy = y + row * (cellH + gap);
      doc.setFillColor.apply(doc, COLORS.light);
      doc.setDrawColor.apply(doc, COLORS.line);
      doc.setLineWidth(0.2);
      doc.roundedRect(x, cy, cellW, cellH, 1.5, 1.5, "FD");
      doc.setTextColor.apply(doc, COLORS.gold);
      doc.setFont(FONT_LATIN, "bold");
      doc.setFontSize(13);
      var str = String(c[1]);
      doc.setFont(pickFont(FONT_LATIN, str), "bold");
      doc.text(str, x + cellW / 2, cy + 6.5, { align: "center" });
      doc.setTextColor.apply(doc, COLORS.muted);
      doc.setFont(FONT_LATIN, "normal");
      doc.setFontSize(6.5);
      doc.setFont(pickFont(FONT_LATIN, c[0]), "normal");
      doc.text(String(c[0]).toUpperCase(), x + cellW / 2, cy + cellH - 2.4, { align: "center" });
    });
    return y + 2 * (cellH + gap) + 5;
  }

  // ---- Build report PDF -----------------------------------------------------
  function buildReportDoc() {
    var list = typeof reportFilteredList === "function" ? reportFilteredList() : [];
    var doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    doc.setProperties({
      title: "Sports Achievement Report" + (academicYear() ? " - " + academicYear() : ""),
      subject: "Year-wise Sports Achievement Report",
      author: INSTITUTION_NAME,
      creator: "NASC SPORTS Staff Dashboard",
    });
    registerFonts(doc);

    var startY = drawReportHeader(doc) + 6;
    startY = drawSummary(doc, startY) + 3;

    var body = list.map(function (a, i) {
      return [
        i + 1,
        String(a.student_name || "") + (a.department ? "\n" + String(a.department) : ""),
        String(typeof awardName === "function" ? awardName(a) : (a.position || a.title || "")),
        String(a.team_individual || "-"),
        String(a.level || "-"),
        String(a.title || "") + (a.competition ? "\n" + String(a.competition) : ""),
        String(typeof fmtAchMonthYear === "function" ? fmtAchMonthYear(a.achievement_year) : (a.achievement_year || "-")),
      ];
    });
    if (body.length === 0) body = [["", "No achievements recorded for this academic year yet.", "", "", "", "", ""]];

    doc.autoTable({
      startY: startY,
      margin: { top: P.m, right: P.m, bottom: P.m + 6, left: P.m },
      head: [["S.No", "Student Name", "Award / Medal", "Team / Individual", "Level", "Event Name", "Month & Year"]],
      body: body,
      theme: "grid",
      rowPageBreak: "avoid",
      styles: {
        font: FONT_LATIN,
        fontSize: 8.5,
        cellPadding: 1.6,
        textColor: COLORS.ink,
        lineColor: COLORS.line,
        lineWidth: 0.15,
        valign: "middle",
        overflow: "linebreak",
      },
      headStyles: {
        font: FONT_LATIN,
        fontStyle: "bold",
        fillColor: COLORS.navy,
        textColor: [255, 255, 255],
        fontSize: 8.5,
        halign: "center",
      },
      bodyStyles: { font: FONT_LATIN },
      alternateRowStyles: { fillColor: COLORS.light },
      columnStyles: {
        0: { cellWidth: 10, halign: "center" },
        1: { cellWidth: 30 },
        2: { cellWidth: 30 },
        3: { cellWidth: 22, halign: "center" },
        4: { cellWidth: 20, halign: "center" },
        5: { cellWidth: 48 },
        6: { cellWidth: 26, halign: "center" },
      },
      didParseCell: function (data) {
        // Switch to the Devanagari font for Indian / Unicode text in a cell.
        var txt = data.cell.raw ? String(data.cell.raw) : "";
        if (hasIndic(txt)) data.cell.styles.font = FONT_IND;
      },
    });

    // Footers for every page (needs total page count, so drawn after the table).
    var total = doc.getNumberOfPages();
    for (var p = 1; p <= total; p++) {
      doc.setPage(p);
      drawReportFooter(doc, p, total);
    }
    return doc;
  }

  // ---- Build certificate PDF (single A4 page) ------------------------------
  function buildCertificateDoc(a) {
    var doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    doc.setProperties({
      title: "Certificate of Achievement",
      subject: "Sports Achievement Certificate",
      author: INSTITUTION_NAME,
      creator: "NASC SPORTS Staff Dashboard",
    });
    registerFonts(doc);

    var ay = a.academic_year || (typeof academicYearLabel === "function" ? academicYearLabel(typeof currentAcademicYearStart === "function" ? currentAcademicYearStart() : new Date().getFullYear()) : "");
    var student = a.student_name || "";
    var award = (typeof awardName === "function" ? awardName(a) : (a.position || a.title || ""));
    var eventName = a.title || "";
    var level = (a.level || "") + (a.level && !/level/i.test(a.level) ? " Level" : "");
    var ti = a.team_individual || "";
    var monthYear = typeof fmtAchMonthYear === "function" ? fmtAchMonthYear(a.achievement_year) : a.achievement_year || "";
    var certNo = "NASC/" + (ay || new Date().getFullYear()) + "/" + String(a.id || "").padStart(4, "0");

    var center = P.w / 2;

    // Watermark (subtle, grayscale-safe, skipped if GState unavailable).
    try {
      if (GState) {
        doc.saveGraphicsState();
        doc.setGState(new GState({ opacity: 0.05 }));
        doc.setTextColor.apply(doc, COLORS.navy);
        doc.setFont(FONT_LATIN, "bold");
        doc.setFontSize(52);
        doc.text(INSTITUTION_NAME, center, P.h / 2, { align: "center", angle: -28 });
        doc.restoreGraphicsState();
      }
    } catch (e) { /* non-fatal */ }

    // Outer + inner elegant border.
    doc.setDrawColor.apply(doc, COLORS.navy);
    doc.setLineWidth(1.1);
    doc.rect(5, 5, P.w - 10, P.h - 10);
    doc.setDrawColor.apply(doc, COLORS.gold);
    doc.setLineWidth(0.6);
    doc.rect(8, 8, P.w - 16, P.h - 16);

    var y = 20;
    drawLogo(doc, center - 7, y, 14);
    y += 18;
    doc.setTextColor.apply(doc, COLORS.navy);
    doc.setFont(FONT_LATIN, "bold");
    doc.setFontSize(15);
    doc.text(INSTITUTION_NAME, center, y, { align: "center" });
    y += 6;
    doc.setTextColor.apply(doc, COLORS.muted);
    doc.setFont(FONT_LATIN, "normal");
    doc.setFontSize(8.5);
    doc.text(DEPT_LINE, center, y, { align: "center" });
    y += 8;
    drawDivider(doc, y, P.m + 6, P.w - P.m - 6);
    y += 9;
    doc.setTextColor.apply(doc, COLORS.gold);
    doc.setFont(FONT_LATIN, "bold");
    doc.setFontSize(20);
    doc.text("CERTIFICATE OF ACHIEVEMENT", center, y, { align: "center" });
    y += 12;
    doc.setTextColor.apply(doc, COLORS.muted);
    doc.setFont(FONT_LATIN, "normal");
    doc.setFontSize(11);
    doc.text("This certificate is proudly presented to", center, y, { align: "center" });
    y += 9;

    // Student name - large, prominent, auto-fit for long names.
    drawFitText(doc, student, center, y, P.w - 50, { size: 26, bold: true, halign: "center", font: fontFor(student) });
    y += 5;
    doc.setDrawColor.apply(doc, COLORS.gold);
    doc.setLineWidth(0.5);
    doc.line(center - 46, y, center + 46, y);
    y += 9;

    doc.setTextColor.apply(doc, COLORS.ink);
    doc.setFont(FONT_LATIN, "normal");
    doc.setFontSize(11.5);
    doc.text("for achieving", center, y, { align: "center" });
    y += 7;
    drawFitText(doc, award, center, y, P.w - 62, { size: 15, bold: true, halign: "center", font: fontFor(award) });
    y += 8.5;
    doc.setTextColor.apply(doc, COLORS.ink);
    doc.setFontSize(11.5);
    doc.text("in", center, y, { align: "center" });
    y += 7;
    drawFitText(doc, eventName, center, y, P.w - 62, { size: 14, bold: true, halign: "center", font: fontFor(eventName) });
    y += 8.5;
    doc.setTextColor.apply(doc, COLORS.ink);
    doc.setFontSize(11.5);
    doc.setFont(pickFont(FONT_LATIN, level), "normal");
    doc.text("at the " + level + (ti ? " as " + ti : ""), center, y, { align: "center" });
    y += 7;
    if (monthYear) {
      doc.text("during " + monthYear, center, y, { align: "center" });
      y += 7;
    }
    doc.setTextColor.apply(doc, COLORS.gold);
    doc.setFont(FONT_LATIN, "bold");
    doc.setTextColor(138, 106, 53);
    doc.text("Academic Year: " + ay, center, y, { align: "center" });
    y += 4.5;
    doc.setTextColor.apply(doc, COLORS.muted);
    doc.setFont(FONT_LATIN, "normal");
    doc.setFontSize(10);
    doc.text("Certificate No: " + certNo, center, y, { align: "center" });
    y += 10;

    // Signature area.
    var sigY1 = P.h - 46, sigY2 = sigY1 + 16;
    var spacer = 24;
    doc.setDrawColor.apply(doc, COLORS.ink);
    doc.setLineWidth(0.3);
    doc.line(center - spacer - 34, sigY1, center - spacer + 34, sigY1);
    doc.line(center + spacer - 34, sigY1, center + spacer + 34, sigY1);
    doc.setTextColor.apply(doc, COLORS.ink);
    doc.setFont(FONT_LATIN, "bold");
    doc.setFontSize(9.5);
    doc.text("Sports Officer", center - spacer, sigY1 + 4);
    doc.text("Principal / Director", center + spacer, sigY1 + 4);
    doc.setTextColor.apply(doc, COLORS.muted);
    doc.setFont(FONT_LATIN, "normal");
    doc.setFontSize(8.5);
    doc.text("Signature", center - spacer, sigY1 + 8);
    doc.text("Signature", center + spacer, sigY1 + 8);
    doc.text("Date: ____________", center, sigY2);

    return doc;
  }

  // ---- Preview / print / download ------------------------------------------
  function showModal() {
    var modal = document.getElementById("pdfPreviewModal");
    if (modal) modal.classList.remove("hidden");
  }
  function hideModal() {
    var modal = document.getElementById("pdfPreviewModal");
    if (modal) modal.classList.add("hidden");
  }

  function failToast(msg) {
    if (typeof toast === "function") toast(msg, "err");
    else console.error(msg);
  }

  function generateBlob(builder, autoPrint, filename) {
    ensureFonts().then(function () {
      var doc = builder();
      var blob = doc.output("blob");
      var url = URL.createObjectURL(blob);
      if (PDF_STATE.blobUrl) URL.revokeObjectURL(PDF_STATE.blobUrl);
      PDF_STATE.blobUrl = url;
      PDF_STATE.doc = doc;
      PDF_STATE.filename = filename || PDF_STATE.expectedFilename || "";
      setTimeout(function () {
        var frame = document.getElementById("pdfViewFrame");
        if (frame) frame.src = url;
        showModal();
        if (autoPrint) doPrint();
      }, 50);
    }).catch(function (err) {
      failToast("PDF generation failed: " + err.message);
    });
  }

  function reportFilename() {
    return "Sports_Achievement_Report_" + (academicYear() || "academic-year")
      .replace(/\u2013/g, "-").replace(/\s+/g, "").replace(/[^\w-]/g, "") + ".pdf";
  }
  function certFilename(a) {
    var name = String(a.student_name || "Student").replace(/[^\w\u0900-\u097F]+/g, "").replace(/\s+/g, "");
    var ay = String(a.academic_year || academicYearLabel(typeof currentAcademicYearStart === "function" ? currentAcademicYearStart() : new Date().getFullYear()) || "")
      .replace(/\u2013/g, "-").replace(/\s+/g, "");
    return "Certificate_" + name + "_" + (ay || "academic-year") + ".pdf";
  }

  function doPrint() {
    var frame = document.getElementById("pdfViewFrame");
    if (!frame || !PDF_STATE.blobUrl) return;
    var tryPrint = function () {
      try {
        frame.contentWindow.focus();
        frame.contentWindow.print();
      } catch (e) {
        var w = window.open(PDF_STATE.blobUrl, "_blank");
        if (w) w.print();
      }
    };
    // Only print once the PDF viewer inside the iframe has loaded, so the
    // print dialog carries the exact generated document (not a blank page).
    if (frame.contentWindow && frame.contentWindow.document && frame.contentWindow.document.readyState === "complete") {
      tryPrint();
      return;
    }
    var once = function () {
      frame.removeEventListener("load", once);
      setTimeout(tryPrint, 60);
    };
    frame.addEventListener("load", once);
    setTimeout(function () { frame.removeEventListener("load", once); tryPrint(); }, 900);
  }
  function doDownload(filename) {
    if (!PDF_STATE.blobUrl) return;
    var a = document.createElement("a");
    a.href = PDF_STATE.blobUrl;
    a.download = filename || PDF_STATE.filename || "document.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (typeof toast === "function") toast("Downloading " + a.download, "ok");
  }

  function currentCertificate(id) {
    if (typeof achievements === "undefined") return null;
    return achievements.find(function (x) { return x.id === id; }) || null;
  }

  // ---- Public API -----------------------------------------------------------
  function reportJob(printMode) {
    PDF_STATE.expectedFilename = reportFilename();
    generateBlob(function () { return buildReportDoc(); }, printMode, reportFilename());
  }
  function certJob(id, printMode) {
    var a = currentCertificate(id);
    if (!a) return failToast("Achievement not found.");
    PDF_STATE.expectedFilename = certFilename(a);
    generateBlob(function () { return buildCertificateDoc(a); }, printMode, certFilename(a));
  }

  window.NascPDF = {
    ready: ensureFonts(),

    previewReport: function () { reportJob(false); },
    printReport: function () { reportJob(true); },
    downloadReport: function () {
      ensureFonts().then(function () {
        var doc = buildReportDoc();
        doc.save(reportFilename());
        if (typeof toast === "function") toast("Downloading " + reportFilename(), "ok");
      }).catch(function (err) { failToast("PDF generation failed: " + err.message); });
    },

    previewCertificate: function (id) { certJob(id, false); },
    printCertificate: function (id) { certJob(id, true); },
    downloadCertificate: function (id) {
      ensureFonts().then(function () {
        var a = currentCertificate(id);
        if (!a) return failToast("Achievement not found.");
        var f = certFilename(a);
        buildCertificateDoc(a).save(f);
        if (typeof toast === "function") toast("Downloading " + f, "ok");
      }).catch(function (err) { failToast("PDF generation failed: " + err.message); });
    },

    printPdf: doPrint,
    downloadPdf: function () { doDownload(PDF_STATE.filename); },
    closePreview: hideModal,
  };
})();
