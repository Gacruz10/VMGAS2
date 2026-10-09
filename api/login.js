import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, collection, addDoc } from "firebase/firestore";

// Inicializamos Firebase usando Variables de Entorno de Vercel
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export default async function handler(req, res) {
  // Solo aceptamos peticiones POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Faltan credenciales' });
  }

  try {
    const userRef = doc(db, "usuarios", username);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) {
      return res.status(404).json({ error: 'El usuario no existe' });
    }

    const userData = userSnap.data();

    // Verificamos la clave en el servidor
    if (String(userData.clave) === String(password)) {
      const ahora = Date.now();
      const vencimiento = ahora + 14400000; // 4 Horas

      // Creamos el token directamente acá
      const tokenRef = await addDoc(collection(db, "tokens"), {
        usuario: username,
        nombre_mostrar: userData.nombre_mostrar,
        creado: ahora,
        expira: vencimiento
      });

      // Mapeamos los permisos
      const permisos = {
        formulario: userData.FORMULARIO === true || userData.FORMULARIO === "true",
        clientes: userData.CLIENTES === true || userData.CLIENTES === "true",
        precios: userData.PRECIOS === true || userData.PRECIOS === "true",
        usuarios: userData.USUARIOS === true || userData.USUARIOS === "true",
        alarmas: userData.ALARMAS === true || userData.ALARMAS === "true",
        tablero: userData.TABLERO === true || userData.TABLERO === "true",
        stock: userData.STOCK === true || userData.STOCK === "true",
        carga: userData.CARGA === true || userData.CARGA === "true",
        finanzas: userData.FINANZAS === true || userData.FINANZAS === "true",
        confinanzas: userData.CONFINANZAS === true || userData.CONFINANZAS === "true",
        gastos: userData.GASTOS === true || userData.GASTOS === "true",
        pin_dinamico: userData.PIN_DINAMICO === true || userData.PIN_DINAMICO === "true",
        flotantes: userData.FLOTANTES === true || userData.FLOTANTES === "true"
      };

      // Devolvemos todo limpio al frontend
      return res.status(200).json({
        success: true,
        tokenId: tokenRef.id,
        nombre: userData.nombre_mostrar || username,
        permisos: permisos
      });

    } else {
      return res.status(401).json({ error: 'Clave incorrecta' });
    }
  } catch (error) {
    console.error("Error en servidor:", error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
}