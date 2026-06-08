require('dotenv').config(); // Carrega as variáveis do .env logo na primeira linha

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { 
  DynamoDBDocumentClient, 
  ScanCommand, 
  GetCommand, 
  PutCommand, 
  DeleteCommand 
} = require("@aws-sdk/lib-dynamodb");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Configurações e Variáveis de Ambiente
const PORT = process.env.PORT || 3001;
const REGION = process.env.AWS_REGION || "us-east-1";
const BUCKET_NAME = process.env.S3_BUCKET_NAME || "streamtube-videos";
const TABLE_NAME = process.env.DYNAMO_TABLE || "streamtube-videos";

const app = express();

// Middlewares
app.use(cors({
  origin: [
    'http://localhost:4200', // Para você testar localmente
    'https://d3ui4bubxzqbnx.cloudfront.net' // O seu front-end oficial na AWS
  ]
}));
app.use(express.json());app.use(express.json());

// Configuração explícita para forçar a leitura das credenciais
const awsConfig = {
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
};

// Inicialização dos Clientes AWS usando o awsConfig
const s3Client = new S3Client(awsConfig);
const dynamoClient = new DynamoDBClient(awsConfig);
const docClient = DynamoDBDocumentClient.from(dynamoClient);

// Configuração do Multer (Upload em Memória)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // Limite de 500 MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["video/mp4", "video/webm", "video/ogg", "video/quicktime"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Formato de vídeo não suportado. Use MP4, WebM ou OGG."));
    }
  }
});

// --- ROTAS ---

// GET /health - Healthcheck para Docker
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    region: REGION,
    bucket: BUCKET_NAME
  });
});

// GET /videos - Listar todos os vídeos (metadados)
app.get("/videos", async (req, res) => {
  try {
    const data = await docClient.send(new ScanCommand({ TableName: TABLE_NAME }));
    
    // Ordenar por uploadedAt DESC
    const videos = (data.Items || []).sort((a, b) => b.uploadedAt - a.uploadedAt);
    
    res.status(200).json({ videos });
  } catch (error) {
    console.error("Erro ao buscar vídeos:", error);
    res.status(500).json({ error: "Erro ao buscar vídeos" });
  }
});

// GET /videos/:id - Buscar vídeo específico com URL assinada
app.get("/videos/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const data = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { id }
    }));

    if (!data.Item) {
      return res.status(404).json({ error: "Vídeo não encontrado" });
    }

    const video = data.Item;

    // Gerar URL assinada do S3 (válida por 1 hora)
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: video.s3Key
    });
    
    const streamUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    res.status(200).json({
      ...video,
      streamUrl
    });
  } catch (error) {
    console.error("Erro ao buscar vídeo:", error);
    res.status(500).json({ error: "Erro interno" });
  }
});

// POST /videos/upload - Upload de novo vídeo
app.post("/videos/upload", upload.single("video"), async (req, res) => {
  try {
    const { title, uploader = "Anônimo", description = "" } = req.body;

    // Validações básicas
    if (!req.file) {
      return res.status(400).json({ error: "Arquivo de vídeo obrigatório" });
    }
    if (!title) {
      return res.status(400).json({ error: "Título obrigatório" });
    }

    const id = uuidv4();
    const ext = path.extname(req.file.originalname) || ".mp4";
    const s3Key = `videos/${id}${ext}`;

    // 1. Upload para o S3
    await s3Client.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      Metadata: {
        title,
        uploader,
        originalName: req.file.originalname
      }
    }));

    // 2. Salvar metadados no DynamoDB
    const item = {
      id,
      title,
      description,
      uploader,
      s3Key,
      bucket: BUCKET_NAME,
      size: req.file.size,
      mimetype: req.file.mimetype,
      uploadedAt: Date.now(),
      views: 0
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: item
    }));

    res.status(201).json({
      message: "Vídeo enviado com sucesso!",
      video: item
    });
  } catch (error) {
    console.error("Erro no upload:", error);
    res.status(500).json({ error: error.message || "Erro no upload" });
  }
});

// POST /videos/:id/view - Incrementar contador de views
app.post("/videos/:id/view", async (req, res) => {
  const { id } = req.params;
  try {
    // Buscar item atual
    const data = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { id }
    }));

    if (!data.Item) {
      return res.status(404).json({ error: "Vídeo não encontrado" });
    }

    const item = data.Item;
    const newViews = (item.views || 0) + 1;

    // Atualizar item (usando PutCommand conforme solicitado no fluxo)
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        ...item,
        views: newViews
      }
    }));

    res.status(200).json({ views: newViews });
  } catch (error) {
    console.error("Erro ao registrar view:", error);
    res.status(500).json({ error: "Erro ao registrar view" });
  }
});

// DELETE /videos/:id - Remover vídeo
app.delete("/videos/:id", async (req, res) => {
  const { id } = req.params;
  try {
    // 1. Buscar metadados para obter a s3Key
    const data = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { id }
    }));

    if (!data.Item) {
      return res.status(404).json({ error: "Vídeo não encontrado" });
    }

    const s3Key = data.Item.s3Key;

    // 2. Deletar do S3
    await s3Client.send(new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key
    }));

    // 3. Deletar do DynamoDB
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { id }
    }));

    res.status(200).json({ message: "Vídeo removido com sucesso" });
  } catch (error) {
    console.error("Erro ao deletar vídeo:", error);
    res.status(500).json({ error: "Erro ao deletar vídeo" });
  }
});

// Inicialização do Servidor
app.listen(PORT, () => {
  console.log(`
  🚀 StreamTube Backend Rodando!
  Porta:   ${PORT}
  Região:  ${REGION}
  Bucket:  ${BUCKET_NAME}
  Tabela:  ${TABLE_NAME}
  `);
});