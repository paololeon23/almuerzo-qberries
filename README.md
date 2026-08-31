# Cocina QBerries

PWA de pedidos de comida en campo: escaneas el QR del supervisor, luego el de cada trabajador. La app dice el **primer apellido**, arma el pedido y lo guarda aunque no haya señal. Al volver internet, sincroniza a Google Sheets sin duplicar filas.

## Cómo publicarla

1. Sube esta carpeta a un hosting **HTTPS** (GitHub Pages, Netlify, Cloudflare Pages).
2. En el celular, abre `https://TU-DOMINIO/install.html`, escanea el QR o entra a la URL.
3. Chrome → menú → **Instalar app** / Añadir a pantalla de inicio.
4. En **Más**, pega la URL de tu Web App de Apps Script.

En local (esta PC):

1. Abre la carpeta con Live Server en `http://127.0.0.1:5500`.
2. **No** abras `index.html` con doble clic (`file://` no carga la app).
3. En Edge, preview de **400px** o un celular (Pixel/iPhone). En ventana ancha de PC se bloquea.

## Google Sheets + Apps Script

1. Crea un Spreadsheet vacío.
2. Extensiones → Apps Script. Pega `gas/Code.gs`.
3. Ejecuta `setupSheets` una vez (autoriza tu cuenta). Quedan las hojas `Pedidos`, `PedidosEspeciales`, `ListaTrabajadores`, `CierreCocina` con columnas oficiales.
4. Implementar → Nueva implementación → **Aplicación web**.
   - Ejecutar como: **tú**
   - Quién tiene acceso: **Cualquier persona**
5. Copia la URL que termina en `/exec` y pégala en la app (Más) o en `data/config.json` → `appsScriptUrl`.

El cliente envía `text/plain` para evitar CORS preflight. El servidor usa `LockService` + `clientId` en caché: el mismo id responde `duplicate=true` y **no** crea otra fila.

## Credenciales QR

Abre `setup.html` (con señal la primera vez) e imprime.

Formato:

`QB1|SUP|S001|RIVERA|Carmen`  
`QB1|WRK|W001|QUISPE|María|Campo Norte`

Puedes editar `data/supervisors.json` con tu lista real.

## Cómo probar offline + sync

1. Instala la PWA. Entra con supervisor (escaneo o **Modo prueba**).
2. Activa **Modo avión**.
3. Escanea un trabajador (o escríbelo). Elige platos → resumen → **Guardar**.
4. Debe quedar **pendiente**. Cierra y reabre: el pedido sigue.
5. Quita el modo avión. Toca **Sync** o espera: se envía solo.
6. Vuelve a sync el mismo pedido: la hoja no se duplica.

**Eliminar caché** borra borradores y la caché de la app. **No** borra la cola ni el historial de 48 h.

## Zona horaria

`America/Lima` (cambiable en `js/config.js` y `data/config.json`).

## Service worker

Caché versionada: `cocina-qb-v1`. Si publicas un cambio, sube el número en `sw.js` y `js/config.js`.
