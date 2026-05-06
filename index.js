const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'ebook-worker' });
});

// Endpoint principal: generar ebook
app.post('/generate', async (req, res) => {
  const { topic, titulo, subtitulo, capitulos = 5, idioma = 'es', callback_url } = req.body;

  if (!topic) {
    return res.status(400).json({ error: 'Falta el campo topic' });
  }

  try {
    // 1. Generar contenido con Claude
    const prompt = `Eres un experto escritor de ebooks educativos en ${idioma === 'es' ? 'español' : 'inglés'}.

Genera un ebook completo sobre: "${topic}"
Título: ${titulo || topic}
${subtitulo ? `Subtítulo: ${subtitulo}` : ''}
Número de capítulos: ${capitulos}

Estructura requerida (usa exactamente estos marcadores):
[TITULO] El título del ebook [/TITULO]
[INTRODUCCION] Introducción de 2-3 párrafos [/INTRODUCCION]
[CAPITULO_1] Título del capítulo 1 [/CAPITULO_1]
[CONTENIDO_1] Contenido detallado del capítulo 1 (mínimo 300 palabras) [/CONTENIDO_1]
... (repite para cada capítulo)
[CONCLUSION] Conclusión de 2 párrafos [/CONCLUSION]

Escribe contenido valioso, práctico y bien estructurado.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    });

    const contenido = message.content[0].text;

    // 2. Convertir a HTML limpio
    const html = contenidoAHTML(contenido, titulo || topic, subtitulo);

    // 3. Generar PDF con PDFShift
    let pdfUrl = null;
    if (process.env.PDFSHIFT_KEY) {
      try {
        const pdfRes = await axios.post(
          'https://api.pdfshift.io/v3/convert/pdf',
          {
            source: html,
            landscape: false,
            use_print: false,
            margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' }
          },
          {
            auth: { username: 'api', password: process.env.PDFSHIFT_KEY },
            responseType: 'arraybuffer'
          }
        );
        // Guardar en memoria base64
        pdfUrl = Buffer.from(pdfRes.data).toString('base64');
      } catch (pdfErr) {
        console.error('PDFShift error:', pdfErr.message);
      }
    }

    const resultado = {
      success: true,
      titulo: titulo || topic,
      contenido_html: html,
      contenido_texto: contenido,
      pdf_base64: pdfUrl,
      palabras: contenido.split(' ').length,
      capitulos_generados: capitulos
    };

    // 4. Si hay callback_url, enviar resultado ahí (async)
    if (callback_url) {
      axios.post(callback_url, resultado).catch(e => console.error('Callback error:', e.message));
    }

    res.json(resultado);

  } catch (err) {
    console.error('Error generating ebook:', err);
    res.status(500).json({ error: err.message });
  }
});

function contenidoAHTML(texto, titulo, subtitulo) {
  // Parsear marcadores y convertir a HTML bonito
  let html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: Georgia, serif; color: #222; max-width: 800px; margin: 0 auto; padding: 40px; }
  h1 { font-size: 2.5em; color: #1a1a2e; text-align: center; margin-bottom: 10px; }
  h2 { font-size: 1.3em; color: #666; text-align: center; margin-bottom: 40px; font-weight: normal; }
  h3 { font-size: 1.6em; color: #16213e; border-bottom: 2px solid #e94560; padding-bottom: 8px; margin-top: 40px; }
  p { line-height: 1.8; margin-bottom: 16px; text-align: justify; }
  .portada { text-align: center; padding: 80px 40px; border: 3px solid #e94560; margin-bottom: 60px; }
  .intro { background: #f8f9fa; padding: 24px; border-left: 4px solid #e94560; margin: 30px 0; }
  .conclusion { background: #1a1a2e; color: #fff; padding: 30px; margin-top: 40px; border-radius: 8px; }
  .conclusion p { color: #ccc; }
</style>
</head>
<body>
<div class="portada">
  <h1>${titulo}</h1>
  ${subtitulo ? `<h2>${subtitulo}</h2>` : ''}
</div>`;

  // Extraer secciones con regex
  const introMatch = texto.match(/\[INTRODUCCION\]([\s\S]*?)\[\/INTRODUCCION\]/);
  if (introMatch) {
    html += `<div class="intro"><p>${introMatch[1].trim().replace(/\n\n/g, '</p><p>')}</p></div>`;
  }

  // Capítulos (hasta 10)
  for (let i = 1; i <= 10; i++) {
    const capTitulo = texto.match(new RegExp(`\\[CAPITULO_${i}\\]([\\s\\S]*?)\\[\\/CAPITULO_${i}\\]`));
    const capContenido = texto.match(new RegExp(`\\[CONTENIDO_${i}\\]([\\s\\S]*?)\\[\\/CONTENIDO_${i}\\]`));
    if (capTitulo && capContenido) {
      html += `<h3>Capítulo ${i}: ${capTitulo[1].trim()}</h3>`;
      html += `<p>${capContenido[1].trim().replace(/\n\n/g, '</p><p>')}</p>`;
    }
  }

  const concMatch = texto.match(/\[CONCLUSION\]([\s\S]*?)\[\/CONCLUSION\]/);
  if (concMatch) {
    html += `<div class="conclusion"><h3 style="color:#e94560">Conclusión</h3><p>${concMatch[1].trim().replace(/\n\n/g, '</p><p>')}</p></div>`;
  }

  html += `</body></html>`;
  return html;
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ebook-worker corriendo en puerto ${PORT}`));
