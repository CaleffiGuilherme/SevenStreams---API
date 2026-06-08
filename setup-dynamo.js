require('dotenv').config(); // Carrega as variáveis do .env logo na primeira linha

const { 
  DynamoDBClient, 
  DescribeTableCommand, 
  CreateTableCommand, 
  UpdateTimeToLiveCommand 
} = require("@aws-sdk/client-dynamodb");

// Configurações vindas do ambiente
const REGION = process.env.AWS_REGION || "us-east-1";
const TABLE_NAME = process.env.DYNAMO_TABLE || "streamtube-videos";

// Configuração explícita para forçar a leitura das credenciais
const awsConfig = {
  region: REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
};

const client = new DynamoDBClient(awsConfig);

async function setup() {
  console.log(`⏱ Iniciando setup do DynamoDB na região ${REGION}...`);

  try {
    // 1. Verificar se a tabela já existe
    try {
      await client.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
      console.log(`ℹ️ Tabela "${TABLE_NAME}" já existe. Pulando criação.`);
    } catch (err) {
      if (err.name === "ResourceNotFoundException") {
        console.log(`✅ Criando tabela "${TABLE_NAME}"...`);
        
        const createParams = {
          TableName: TABLE_NAME,
          AttributeDefinitions: [
            { AttributeName: "id", AttributeType: "S" },
            { AttributeName: "uploader", AttributeType: "S" },
            { AttributeName: "uploadedAt", AttributeType: "N" }
          ],
          KeySchema: [
            { AttributeName: "id", KeyType: "HASH" }
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: "uploader-date-index",
              KeySchema: [
                { AttributeName: "uploader", KeyType: "HASH" },
                { AttributeName: "uploadedAt", KeyType: "RANGE" }
              ],
              Projection: { ProjectionType: "ALL" },
              ProvisionedThroughput: {
                ReadCapacityUnits: 5,
                WriteCapacityUnits: 5
              }
            }
          ],
          ProvisionedThroughput: {
            ReadCapacityUnits: 5,
            WriteCapacityUnits: 5
          },
          Tags: [
            { Key: "Project", Value: "StreamTube" },
            { Key: "Discipline", Value: "Programacao-Distribuida" },
            { Key: "Environment", Value: "demo" }
          ]
        };

        await client.send(new CreateTableCommand(createParams));
        console.log(`✅ Tabela criada com sucesso!`);

        // Aguardar um pouco para a tabela ficar ativa antes de habilitar TTL
        console.log("⏱ Aguardando estabilização para configurar TTL...");
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        throw err;
      }
    }

    // 2. Habilitar TTL (Time To Live)
    try {
      console.log(`✅ Habilitando TTL no atributo "expiresAt"...`);
      await client.send(new UpdateTimeToLiveCommand({
        TableName: TABLE_NAME,
        TimeToLiveSpecification: {
          AttributeName: "expiresAt",
          Enabled: true
        }
      }));
      console.log(`✅ TTL configurado.`);
    } catch (ttlErr) {
      // Engolir erro silenciosamente se falhar (pode já estar habilitado ou tabela ainda em criação)
      console.log(`ℹ️ Nota: Não foi possível atualizar TTL (pode já estar ativo).`);
    }

    console.log("\nEstrutura criada:");
    console.log(`- Tabela: ${TABLE_NAME}`);
    console.log(`- PK: id (String)`);
    console.log(`- GSI: uploader-date-index (uploader, uploadedAt)`);
    console.log(`- TTL: expiresAt`);
    console.log("\n🚀 Setup concluído! Pode subir o backend.");

  } catch (error) {
    console.error("❌ Erro fatal no setup:", error);
    process.exit(1);
  }
}

setup();