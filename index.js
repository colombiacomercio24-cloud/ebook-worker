const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get('/', (req, res) => res.json({ status: 'ok', service: 'ebook-worker v2' }));

// ── GENERAR EBOOK ─────────────────────────────────────────────────────────────
app.post('/generate', async (req, res) => {
  const { topic, titulo, capitulos = 5 } = req.body;
  if (!topic) return res.status(400).json({ error: 'Falta topic' });

  try {
    // 1. Claude genera estructura JSON del ebook
    console.log('1. Generando contenido con Claude...');
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: `Eres experto en crear ebooks de infoproductos para vender por WhatsApp en Latinoamérica.

Basándote en este copy de anuncio:
"${topic}"

Genera un ebook completo en español. Responde SOLO con JSON válido, sin texto antes ni después:

{
  "titulo": "Título atractivo del ebook (máx 60 chars)",
  "subtitulo": "Subtítulo que complementa (máx 80 chars)",
  "color_primario": "#e85d04",
  "color_secundario": "#f48c06",
  "emoji_tema": "🧄",
  "prompt_imagen": "Professional cartoon illustration of [describe persona target del producto] in [contexto relevante], flat design style, vibrant warm colors orange coral yellow, portrait orientation, high quality digital art, no text",
  "capitulos": [
    {
      "numero": 1,
      "tag": "FUNDAMENTOS",
      "titulo": "Título del capítulo",
      "cuerpo": "3-4 párrafos de contenido valioso y práctico relacionado al producto...",
      "tip1_titulo": "💡 Tip clave",
      "tip1_texto": "Consejo práctico corto",
      "tip2_titulo": "🚀 Acción inmediata",
      "tip2_texto": "Qué hacer hoy mismo"
    }
  ]
}

Genera exactamente ${Math.min(capitulos, 6)} capítulos. Cada cuerpo mínimo 200 palabras. El contenido debe ser valioso, práctico y relacionado directamente al producto del anuncio.`
      }]
    });

    let ebookData;
    try {
      const rawText = msg.content[0].text.replace(/```json|```/g, '').trim();
      ebookData = JSON.parse(rawText);
    } catch(e) {
      throw new Error('Claude no devolvió JSON válido: ' + e.message);
    }

    console.log('✅ Contenido generado:', ebookData.titulo);

    // 2. Generar imagen con Fal.ai para cada capítulo (en paralelo, máx 3)
    console.log('2. Generando imágenes con Fal.ai...');
    const caps = ebookData.capitulos || [];
    
    async function generarImagen(prompt) {
      if (!process.env.FAL_KEY) return null;
      try {
        const r = await axios.post('https://fal.run/fal-ai/flux/dev',
          {
            prompt: prompt,
            image_size: 'portrait_4_3',
            num_inference_steps: 28,
            num_images: 1
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Key ' + process.env.FAL_KEY
            },
            timeout: 90000
          }
        );
        const imgUrl = r.data?.images?.[0]?.url;
        if (!imgUrl) return null;
        // Descargar imagen y convertir a base64
        const imgRes = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30000 });
        return 'data:image/jpeg;base64,' + Buffer.from(imgRes.data).toString('base64');
      } catch(e) {
        console.error('Fal.ai error:', e.message);
        return null;
      }
    }

    // Generar imagen principal (portada) y para primeros 3 capítulos
    const promptBase = ebookData.prompt_imagen || `Professional cartoon illustration related to: ${ebookData.titulo}, flat design style, vibrant warm colors, portrait orientation, high quality digital art, no text`;
    
    const imagePromises = caps.slice(0, 3).map((cap, i) => 
      generarImagen(i === 0 ? promptBase : promptBase.replace('portrait_4_3', 'landscape_4_3'))
    );
    const imagenes = await Promise.all(imagePromises);
    console.log('✅ Imágenes generadas:', imagenes.filter(Boolean).length);

    // 3. Construir HTML del ebook completo
    console.log('3. Construyendo HTML...');
    const color1 = ebookData.color_primario || '#e85d04';
    const color2 = ebookData.color_secundario || '#f48c06';

    function paginaPortada() {
      const img = imagenes[0];
      const bgStyle = img
        ? `background-image: url('${img}'); background-size: cover; background-position: center top;`
        : `background: linear-gradient(135deg, ${color1}, ${color2});`;
      return `
<div class="page">
  <div class="header">
    <span class="header-label">${ebookData.titulo}</span>
    <span class="header-num">Portada</span>
  </div>
  <div style="${bgStyle} position:absolute; top:0; left:0; right:0; bottom:0;"></div>
  <div class="gradient-overlay"></div>
  <div class="content">
    <div class="tag">${ebookData.emoji_tema || '⚡'} Guía Completa</div>
    <div class="title">${ebookData.titulo}</div>
    <p class="body-text">${ebookData.subtitulo || ''}</p>
  </div>
</div>`;
    }

    function paginaCapitulo(cap, idx) {
      const img = imagenes[idx] || imagenes[0];
      const bgStyle = img
        ? `background-image: url('${img}'); background-size: cover; background-position: center top;`
        : `background: linear-gradient(135deg, ${color1}, ${color2});`;
      
      const cuerpoParrafos = (cap.cuerpo || '').split('\n\n')
        .filter(p => p.trim())
        .map(p => `<p class="body-text">${p.trim()}</p>`)
        .join('');

      return `
<div class="page">
  <div class="header">
    <span class="header-label">${ebookData.titulo}</span>
    <span class="header-num">Capítulo ${cap.numero}</span>
  </div>
  <div style="${bgStyle} position:absolute; top:0; left:0; right:0; bottom:0;"></div>
  <div class="gradient-overlay"></div>
  <div class="content">
    <div class="tag">⚡ ${cap.tag || 'Capítulo ' + cap.numero}</div>
    <div class="title">${cap.titulo}</div>
    ${cuerpoParrafos}
    <div class="tips-row">
      <div class="tip">
        <div class="tip-title">${cap.tip1_titulo || '💡 Tip clave'}</div>
        <div class="tip-text">${cap.tip1_texto || ''}</div>
      </div>
      <div class="tip">
        <div class="tip-title">${cap.tip2_titulo || '🚀 Acción'}</div>
        <div class="tip-text">${cap.tip2_texto || ''}</div>
      </div>
    </div>
  </div>
</div>`;
    }

    const htmlPages = [paginaPortada(), ...caps.map((cap, i) => paginaCapitulo(cap, i))].join('\n');

    const htmlCompleto = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@400;600;700;800&family=Montserrat:wght@400;500;600&display=swap" rel="stylesheet">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:"Montserrat",sans-serif; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
.page {
  width: 794px; height: 1123px;
  position: relative; overflow: hidden;
  page-break-after: always;
}
.header {
  position: absolute; top: 0; left: 0; right: 0; height: 52px;
  background: ${color1}f2;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 36px; z-index: 10;
}
.header-label { font-size:10px; font-weight:700; color:rgba(255,255,255,0.75); letter-spacing:3px; text-transform:uppercase; }
.header-num { font-size:12px; font-weight:700; color:#fff; background:rgba(255,255,255,0.2); padding:4px 14px; border-radius:20px; }
.gradient-overlay {
  position: absolute; bottom: 0; left: 0; right: 0; height: 560px;
  background: linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(10,3,0,0.6) 35%, rgba(10,3,0,0.92) 70%, rgba(5,1,0,0.97) 100%);
  z-index: 2;
}
.content { position:absolute; bottom:0; left:0; right:0; padding:0 40px 36px; z-index:3; }
.tag {
  font-family:"Baloo 2",cursive; display:inline-block;
  background:${color1}; color:#fff; font-size:11px; font-weight:700;
  padding:5px 16px; border-radius:20px; letter-spacing:1px; text-transform:uppercase; margin-bottom:14px;
}
.title { font-family:"Baloo 2",cursive; font-size:32px; font-weight:800; color:#fff; line-height:1.15; margin-bottom:12px; text-shadow:0 2px 8px rgba(0,0,0,0.4); }
.body-text { font-size:12.5px; color:rgba(255,255,255,0.88); line-height:1.65; margin-bottom:12px; text-shadow:0 1px 4px rgba(0,0,0,0.5); max-width:700px; }
.tips-row { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:8px; }
.tip { background:rgba(255,255,255,0.12); border:1px solid rgba(255,255,255,0.2); border-left:3px solid ${color1}; border-radius:0 10px 10px 0; padding:12px 16px; }
.tip-title { font-size:11px; font-weight:700; color:${color2}; margin-bottom:4px; text-transform:uppercase; letter-spacing:1px; }
.tip-text { font-size:11px; color:rgba(255,255,255,0.85); line-height:1.5; }
</style>
</head>
<body>
${htmlPages}
</body>
</html>`;

    // 4. PDF con PDFShift
    console.log('4. Generando PDF con PDFShift...');
    let pdfBase64 = null;
    if (process.env.PDFSHIFT_KEY) {
      const pdfRes = await axios.post(
        'https://api.pdfshift.io/v3/convert/pdf',
        { source: htmlCompleto, format: 'A4', margin: { top: 0, right: 0, bottom: 0, left: 0 } },
        {
          auth: { username: 'api', password: process.env.PDFSHIFT_KEY },
          responseType: 'arraybuffer',
          timeout: 120000
        }
      );
      pdfBase64 = Buffer.from(pdfRes.data).toString('base64');
      console.log('✅ PDF generado');
    }

    res.json({
      success: true,
      titulo: ebookData.titulo,
      pdf_base64: pdfBase64,
      palabras: caps.reduce((acc, c) => acc + (c.cuerpo || '').split(' ').length, 0),
      capitulos_generados: caps.length
    });

  } catch(err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ebook-worker v2 en puerto ${PORT}`));
