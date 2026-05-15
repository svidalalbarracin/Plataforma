require('dotenv').config();
const forge = require('node-forge');
const soap  = require('soap');
const fs    = require('fs');
const path  = require('path');

const WSAA_WSDL  = 'https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl';
const CERT_PATH  = path.join(__dirname, '../../certs/certificado.crt');
const KEY_PATH   = path.join(__dirname, '../../certs/privada.key');
const SERVICIO   = 'wsfev1';

let ticketCache = null;

function generarLoginTicketRequest() {
  const ahora   = new Date();
  const expira  = new Date(ahora.getTime() + 12 * 60 * 60 * 1000); // 12 horas

  const toISOAR = d => d.toISOString().replace('Z', '-00:00');

  return `<?xml version="1.0" encoding="UTF-8"?>\
<loginTicketRequest version="1.0">\
<header>\
<uniqueId>${Math.floor(ahora.getTime() / 1000)}</uniqueId>\
<generationTime>${toISOAR(ahora)}</generationTime>\
<expirationTime>${toISOAR(expira)}</expirationTime>\
</header>\
<service>${SERVICIO}</service>\
</loginTicketRequest>`;
}

function firmarCMS(xml) {
  const certPem = fs.readFileSync(CERT_PATH, 'utf8');
  const keyPem  = fs.readFileSync(KEY_PATH,  'utf8');

  const cert = forge.pki.certificateFromPem(certPem);
  const key  = forge.pki.privateKeyFromPem(keyPem);

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(xml, 'utf8');
  p7.addCertificate(cert);
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType,  value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime,  value: new Date() },
    ],
  });
  p7.sign();

  const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
  return Buffer.from(der, 'binary').toString('base64');
}

function parsearTA(xml) {
  const get = tag => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
    if (!m) throw new Error(`Campo <${tag}> no encontrado en respuesta del WSAA`);
    return m[1].trim();
  };
  return {
    token:  get('token'),
    sign:   get('sign'),
    expira: new Date(get('expirationTime')),
  };
}

async function getTicketAcceso() {
  if (ticketCache && new Date() < ticketCache.expira) {
    return { token: ticketCache.token, sign: ticketCache.sign };
  }

  const xml = generarLoginTicketRequest();
  const cms = firmarCMS(xml);

  const client = await soap.createClientAsync(WSAA_WSDL);
  const [result] = await client.loginCmsAsync({ in0: cms });
  const ta = parsearTA(result.loginCmsReturn);

  ticketCache = ta;
  console.log(`[wsaa] Nuevo ticket obtenido. Expira: ${ta.expira.toISOString()}`);
  return { token: ta.token, sign: ta.sign };
}

module.exports = { getTicketAcceso };
