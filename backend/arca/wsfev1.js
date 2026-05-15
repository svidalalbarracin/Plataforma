require('dotenv').config();
const soap = require('soap');
const { getTicketAcceso } = require('./wsaa');

const WSFEV1_WSDL = 'https://servicios1.afip.gov.ar/wsfev1/service.asmx?WSDL';

let soapClient = null;

async function getClient() {
  if (!soapClient) {
    soapClient = await soap.createClientAsync(WSFEV1_WSDL);
  }
  return soapClient;
}

async function getAuth() {
  const { token, sign } = await getTicketAcceso();
  return {
    Token: token,
    Sign:  sign,
    Cuit:  process.env.CUIT,
  };
}

function verificarErrores(res) {
  if (!res.Errors) return;
  const errs = res.Errors.Err;
  const lista = Array.isArray(errs) ? errs : [errs];
  throw new Error(`ARCA: ${lista.map(e => `[${e.Code}] ${e.Msg}`).join(' | ')}`);
}

async function consultarUltimoComprobante(puntoVenta, tipoComprobante) {
  const client = await getClient();
  const Auth   = await getAuth();

  const [result] = await client.FECompUltimoAutorizadoAsync({
    Auth,
    PtoVta:   puntoVenta,
    CbteTipo: tipoComprobante,
  });

  const res = result.FECompUltimoAutorizadoResult;
  verificarErrores(res);
  return res.CbteNro;
}

async function consultarComprobante(puntoVenta, tipoComprobante, numero) {
  const client = await getClient();
  const Auth   = await getAuth();

  const [result] = await client.FECompConsultarAsync({
    Auth,
    FeCompConsReq: {
      CbteTipo: tipoComprobante,
      PtoVta:   puntoVenta,
      CbteNro:  numero,
    },
  });

  const res = result.FECompConsultarResult;
  verificarErrores(res);
  return res.ResultGet;
}

module.exports = { consultarUltimoComprobante, consultarComprobante };
