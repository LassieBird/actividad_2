const express = require("express");
const nodemailer = require("nodemailer");
const dotenv = require("dotenv");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const client = require("prom-client");

dotenv.config();

const app = express();

// ✅ CORS CONFIGURACIÓN
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || process.env.NODE_ENV === 'development') {
      return callback(null, true);
    }

    const allowedOrigins = [
      "http://localhost:5500",
      "http://4.157.178.241",
      "http://localhost:3000",
      "http://localhost:5173",
      "http://34.56.85.127",
      "http://34.58.87.183",
      "http://localhost",
      "http://127.0.0.1:5500",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:5173"
    ];

    if (allowedOrigins.indexOf(origin) !== -1 || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Origen no permitido por CORS'));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"]
};

app.use(cors(corsOptions));
app.use(express.json());
app.options('*', cors(corsOptions));

// ✅ MÉTRICAS PROMETHEUS
const register = new client.Registry();
register.setDefaultLabels({ app: "auth-service", env: process.env.NODE_ENV || "production" });
client.collectDefaultMetrics({ register });

const tokensCounter = new client.Counter({
  name: "auth_tokens_generated_total",
  help: "Total de tokens generados por el servicio de autenticación"
});
const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duración de las peticiones HTTP en segundos",
  labelNames: ["method", "route", "code"],
  buckets: [0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5]
});
const upGauge = new client.Gauge({
  name: "auth_service_up",
  help: "1 = servicio arriba, 0 = abajo"
});

register.registerMetric(tokensCounter);
register.registerMetric(httpRequestDuration);
register.registerMetric(upGauge);

app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on("finish", () => {
    end({ method: req.method, route: req.route ? req.route.path : req.path, code: res.statusCode });
  });
  next();
});

app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// ✅ TRANSPORTER CORREGIDO - CON VERIFICACIÓN
console.log("🔧 Configurando transporter de nodemailer...");
console.log("📧 EMAIL_USER:", process.env.EMAIL_USER ? "✅ Configurado" : "❌ No configurado");
console.log("🔑 EMAIL_PASS:", process.env.EMAIL_PASS ? "✅ Configurado" : "❌ No configurado");

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false
  }
});

transporter.verify(function(error, success) {
  if (error) {
    console.error("❌ Error verificando transporter:", error);
  } else {
    console.log("✅ Transporter listo para enviar correos");
    console.log("📧 Email configurado:", process.env.EMAIL_USER);
  }
});

// 🧠 Almacenamiento temporal de tokens en memoria
const tokensTemporales = new Map();

// ♻️ Limpieza automática de tokens expirados cada 10 minutos
setInterval(() => {
  const ahora = new Date();
  for (const [correo, data] of tokensTemporales.entries()) {
    if (ahora > data.expira) {
      console.log(`🧹 Token expirado eliminado (${correo})`);
      tokensTemporales.delete(correo);
    }
  }
}, 10 * 60 * 1000);

// Función para generar token
function generarToken() {
  return crypto.randomBytes(6).toString("base64").replace(/\W/g, "").substring(0, 8);
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

// ✅ ENDPOINT PARA PROBAR ENVÍO DE EMAIL
app.post("/test-email", async (req, res) => {
  try {
    const testEmail = process.env.EMAIL_USER;

    const result = await transporter.sendMail({
      from: `"Auth Service Test" <${process.env.EMAIL_USER}>`,
      to: testEmail,
      subject: "🧪 Test Email from Auth Service",
      html: `<p>Test enviado correctamente ${new Date().toISOString()}</p>`
    });

    res.json({ ok: true, mensaje: "Correo enviado correctamente", messageId: result.messageId });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/test-email", (req, res) => {
  res.json({ message: "Usa POST para probar el envío de correos" });
});

// ✅ ENDPOINT PRINCIPAL /enviar-token
app.post("/enviar-token", async (req, res) => {
  const { correo, tipo } = req.body;
  if (!correo || !tipo) return res.status(400).json({ error: "Faltan datos: correo o tipo" });

  if (tipo !== "registro" && tipo !== "recuperacion")
    return res.status(400).json({ error: "Tipo debe ser 'registro' o 'recuperacion'" });

  const token = generarToken();
  tokensCounter.inc();

  const subject = tipo === "recuperacion" ? "🔑 Recupera tu cuenta" : "🪪 Verifica tu cuenta";
  const html = `
    <div style="font-family: Arial, sans-serif; padding: 1rem;">
      <h2>${subject}</h2>
      <p>Tu token de <b>${tipo}</b> es:</p>
      <h3 style="color: #007BFF;">${token}</h3>
      <p>Este código expirará en ${process.env.TOKEN_EXP_MIN || 15} minutos.</p>
    </div>
  `;

  try {
    const mailResult = await transporter.sendMail({
      from: `"Servicio de Autenticación" <${process.env.EMAIL_USER}>`,
      to: correo,
      subject,
      html,
    });

    tokensTemporales.set(correo, {
      token,
      tipo,
      creado: new Date(),
      expira: new Date(Date.now() + (Number(process.env.TOKEN_EXP_MIN || 15) * 60000))
    });

    return res.json({
      mensaje: "Correo enviado correctamente",
      token,
      tipo,
      timestamp: new Date().toISOString(),
      messageId: mailResult.messageId
    });
  } catch (error) {
    return res.status(500).json({ error: "No se pudo enviar el correo", detalle: error.message });
  }
});

// ✅ ENDPOINTS PARA CONSULTAR TOKEN
app.post("/token-enviado", (req, res) => {
  const { correo } = req.body;
  if (!correo) return res.status(400).json({ error: "Falta el correo" });
  return obtenerToken(correo, res);
});

app.get("/token-enviado", (req, res) => {
  const { correo } = req.query;
  if (!correo) return res.status(400).json({ error: "Falta el correo" });
  return obtenerToken(correo, res);
});

// 🧩 Función auxiliar
function obtenerToken(correo, res) {
  const dataToken = tokensTemporales.get(correo);
  if (!dataToken)
    return res.status(404).json({ mensaje: "No se encontró token reciente para este correo" });

  const ahora = new Date();
  if (ahora > dataToken.expira) {
    tokensTemporales.delete(correo);
    return res.status(410).json({ mensaje: "El token ha expirado" });
  }

  return res.json({
    mensaje: "Token disponible",
    correo,
    token: dataToken.token, // 🔥 Completo para pruebas
    tipo: dataToken.tipo,
    creado: dataToken.creado,
    expira: dataToken.expira
  });
}

// --- INICIO SERVIDOR ---
upGauge.set(1);
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Servicio de autenticación ejecutándose en el puerto ${PORT}`);
  console.log(`✅ CORS configurado para múltiples orígenes`);
  console.log(`📊 Métricas: http://0.0.0.0:${PORT}/metrics`);
  console.log(`🔧 Test email (POST): curl -X POST http://0.0.0.0:${PORT}/test-email`);
});
