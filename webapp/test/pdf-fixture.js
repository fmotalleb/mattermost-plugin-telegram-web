// Tiny deterministic two-page PDF. Solid page colors let browser tests prove real rendering.
module.exports = function pdfFixture() {
    const content = (color, label) => `${color} rg 0 0 300 400 re f\n1 1 1 rg BT /F1 18 Tf 50 200 Td (${label}) Tj ET\n`;
    const red = content('0.8 0.1 0.1', 'PDF page 1');
    const blue = content('0.1 0.2 0.8', 'PDF page 2');
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        `<< /Length ${Buffer.byteLength(red)} >>\nstream\n${red}endstream`,
        `<< /Length ${Buffer.byteLength(blue)} >>\nstream\n${blue}endstream`,
    ];
    let pdf = '%PDF-1.4\n', offsets = [0];
    objects.forEach((object, i) => {offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;});
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf);
};
