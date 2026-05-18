require('dotenv').config();
const forge = require('node-forge');
const soap  = require('soap');
const fs    = require('fs');
const path  = require('path');

const WSAA_WSDL  = 'https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl';
const CERT_PATH  = path.join(__dirname, '../../certs/certificado.crt');
const KEY_PATH   = path.join(__dirname, '../../certs/privada.key');
const SERVICIO   = 'wsfe';

let ticketCache = null;

function generarLoginTicketRequest() {
  const ahora  = new Date();
  // generationTime: unos minutos en el pasado para tolerar desfase de reloj
  // expirationTime: solo minutos después (la validez del TA la fija ARCA internamente)
  const gen    = new Date(ahora.getTime() - 10 * 60 * 1000);
  const expira = new Date(ahora.getTime() + 10 * 60 * 1000);

  // ARCA espera la hora local de Argentina (UTC-3) sin milisegundos
  const toISOAR = d => {
    const ar = new Date(d.getTime() - 3 * 60 * 60 * 1000);
    return ar.toISOString().replace(/\.\d{3}Z$/, '-03:00');
  };

  return `<?xml version="1.0" encoding="UTF-8"?>\
<loginTicketRequest version="1.0">\
<header>\
<uniqueId>${Math.floor(ahora.getTime() / 1000)}</uniqueId>\
<generationTime>${toISOAR(gen)}</generationTime>\
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
