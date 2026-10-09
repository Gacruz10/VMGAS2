// Archivo: api/clientes.js

export default async function handler(req, res) {
  // Configuramos los encabezados para evitar problemas de CORS si probás local
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Equivalente a tu doGet('listclientes')
  if (req.method === 'GET') {
    try {
      // Acá meteremos la lectura a Firestore en el próximo paso
      const clientesMock = [{ id: 1, nombre: "Juan" }, { id: 2, nombre: "Pedro" }];
      
      return res.status(200).json({ status: 'success', data: clientesMock });
    } catch (error) {
      return res.status(500).json({ status: 'error', message: error.message });
    }
  }

  // Equivalente a tu doPost('saveclientes')
  if (req.method === 'POST') {
    try {
      const body = req.body; // Vercel ya te parsea el JSON automáticamente
      // Acá meteremos la escritura a Firestore
      
      return res.status(200).json({ status: 'success', message: 'Cliente guardado' });
    } catch (error) {
      return res.status(500).json({ status: 'error', message: error.message });
    }
  }

  // Si le pegan con un método que no es GET ni POST
  return res.status(405).json({ status: 'error', message: 'Método no permitido' });
}