# Google Search Console MCP (OAuth)

[![CI](https://github.com/rafavillaplana/search-console-oauth-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/rafavillaplana/search-console-oauth-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/search-console-oauth-mcp.svg)](https://www.npmjs.com/package/search-console-oauth-mcp)
[![Licencia: MIT](https://img.shields.io/badge/licencia-MIT-blue.svg)](LICENSE)

[English](README.md) · **Español**

Servidor [MCP](https://modelcontextprotocol.io) local que permite a Claude consultar **Google Search Console** en lenguaje natural, **iniciando sesión con tu cuenta de Google en el navegador**:

> *"¿Qué propiedades tengo en Search Console?"*
> *"¿Qué consultas han perdido más clics este mes respecto al anterior en sc-domain:cliente.es?"*
> *"¿Está indexada esta URL y qué canónica ha elegido Google?"*

**La diferencia con los conectores de cuenta de servicio:** con una cuenta de servicio (`xxx@proyecto.iam.gserviceaccount.com`) hay que añadir ese correo como usuario en cada propiedad, una a una. Aquí Claude actúa **como tú**: inicias sesión una vez y ve **todas las propiedades a las que ya tiene acceso tu cuenta de Google**, incluidas las que te compartan mañana.

- **Se ejecuta en tu ordenador.** Habla directamente con la API oficial de Search Console. Sin servidores intermedios.
- **Tu propio cliente OAuth.** Lo creas en tu proyecto de Google Cloud; no dependes de la app de nadie.
- **Login una sola vez.** El token de renovación se guarda en un archivo local que solo tu usuario puede leer, y el acceso se renueva solo.
- **Solo lectura.** Permiso `webmasters.readonly`: no puede tocar propiedades, usuarios ni sitemaps.

## 1. Crea tu cliente OAuth en Google Cloud (5 minutos, una sola vez)

1. Entra en [Google Cloud Console](https://console.cloud.google.com/) y crea un proyecto (por ejemplo, *Claude Search Console*).
2. **Activa la API:** *APIs y servicios → Biblioteca →* busca **Google Search Console API** → *Habilitar*.
3. **Pantalla de consentimiento** (*Google Auth Platform*):
   - *Información de la marca:* nombre de la app (por ejemplo, *Claude GSC*) y tu correo de asistencia.
   - *Público:*
     - **Cuenta de Google Workspace y solo usuarios de tu organización →** elige **Interno**. Sin avisos y sin caducidad.
     - **Cuenta de Gmail o usuarios de fuera →** elige **Externo** y después pulsa **Publicar aplicación** para pasarla a **En producción**.
       ⚠️ Si la dejas en *Prueba*, Google caduca el acceso **cada 7 días** y tendrás que volver a iniciar sesión.
   - *Acceso a datos (opcional):* añade el permiso `.../auth/webmasters.readonly`.
4. **Crea el cliente:** *Clientes → Crear cliente →* Tipo de aplicación **App de escritorio** → *Crear*.
   Copia el **ID de cliente** (`….apps.googleusercontent.com`) y el **Secreto del cliente** (`GOCSPX-…`).

No hace falta verificar la app con Google para usarla tú (o tu equipo, hasta 100 usuarios). Como no está verificada, la primera vez Google mostrará *"Google no ha verificado esta aplicación"*: pulsa **Configuración avanzada → Ir a Claude GSC**. Es tu propia app, en tu propio proyecto.

## 2. Instálalo

### Claude Desktop, con un clic (recomendado)

1. Descarga el último **`search-console-oauth-mcp-x.y.z.mcpb`** desde [Releases](https://github.com/rafavillaplana/search-console-oauth-mcp/releases/latest).
2. Haz doble clic (o arrástralo sobre Claude Desktop, o *Configuración → Extensiones → Instalar extensión…*).
3. Pega el **ID de cliente** y el **Secreto del cliente** y activa la extensión.

Claude Desktop ejecuta la extensión con su propio Node.js integrado, así que no tienes que instalar nada.

### Claude Desktop, configuración manual

Necesitas [Node.js](https://nodejs.org) 20 o superior. *Configuración → Desarrollador → Editar configuración*:

```json
{
  "mcpServers": {
    "search-console": {
      "command": "npx",
      "args": ["-y", "search-console-oauth-mcp"],
      "env": {
        "GSC_OAUTH_CLIENT_ID": "tu-id.apps.googleusercontent.com",
        "GSC_OAUTH_CLIENT_SECRET": "GOCSPX-..."
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add search-console --scope user \
  -e GSC_OAUTH_CLIENT_ID=tu-id.apps.googleusercontent.com \
  -e GSC_OAUTH_CLIENT_SECRET=GOCSPX-... \
  -- npx -y search-console-oauth-mcp
```

En lugar del ID y el secreto puedes usar el JSON que descarga Google: `-e GSC_OAUTH_CLIENT_FILE=/ruta/client_secret_xxx.json`.

## 3. Inicia sesión

Pregúntale cualquier cosa a Claude (por ejemplo, *"lista mis propiedades de Search Console"*). La primera vez se abre el navegador con la pantalla de Google: elige tu cuenta y **marca el permiso de Search Console**. Verás *"Connected to Search Console ✔"* y Claude seguirá con la respuesta.

- Si el navegador no se abre, Claude te dará el enlace para abrirlo tú en el mismo ordenador.
- Desde terminal también puedes iniciar sesión con `npx search-console-oauth-mcp auth` (con las mismas variables de entorno).
- Para **cambiar de cuenta de Google**, pídele a Claude que cierre la sesión (`sign_out`) y vuelve a preguntar.

## Herramientas

| Herramienta | Para qué sirve |
|---|---|
| `list_sites` | Todas las propiedades a las que tiene acceso tu cuenta, con su nivel de permiso |
| `get_site_overview` | Clics, impresiones, CTR y posición de un periodo frente al anterior (o al año pasado) |
| `get_performance` | Search Analytics completo: por consulta, página, país, dispositivo, fecha y aspecto en búsqueda, con filtros (incluidas regex) |
| `get_performance_over_time` | Serie temporal por día, semana o mes, de todo el sitio o de una página/consulta |
| `compare_periods` | Consultas o páginas que más ganan o pierden entre dos periodos (nuevas y perdidas incluidas) |
| `inspect_url` | Inspección de URL: indexación, cobertura, último rastreo, canónica de Google frente a la declarada, rich results |
| `list_sitemaps` | Sitemaps enviados, fechas, errores y avisos |
| `auth_status` · `sign_in` · `sign_out` | Ver la cuenta conectada, iniciar sesión o desconectarla |

Por defecto los datos son de los **últimos 28 días completos** (Search Console tiene ~2 días de retraso). Las fechas van en horario del Pacífico, como en la propia herramienta.

## Seguridad y privacidad

- El conector solo pide **lectura** de Search Console (`webmasters.readonly`) y tu correo (para mostrarte qué cuenta está conectada).
- El token de renovación se guarda en `~/.search-console-oauth-mcp/token.json` (en Windows, `C:\Users\<tú>\.search-console-oauth-mcp\token.json`), con permisos solo para tu usuario. Puedes cambiar la ruta con `GSC_TOKEN_PATH`.
- El inicio de sesión usa el flujo oficial de Google para apps de escritorio: redirección a `127.0.0.1` + PKCE. El enlace caduca a los 10 minutos y sirve una sola vez.
- `sign_out` revoca el acceso en Google y borra el token. También puedes revocarlo en [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- No compartas tu secreto de cliente ni el archivo de token. Más detalles en [SECURITY.md](SECURITY.md).

## Problemas frecuentes

| Mensaje | Solución |
|---|---|
| *Google Search Console API has not been used / is disabled* | Activa la API en el mismo proyecto de Google Cloud que el cliente OAuth |
| *The saved Google sign-in has expired or was revoked* cada semana | La app está en modo *Prueba*: publícala (*En producción*) o usa *Interno* |
| *has no access to this property* | Usa el `siteUrl` exacto de `list_sites` (`sc-domain:dominio.com` o `https://www.dominio.com/`) |
| *Search Console permission was not granted* | Cierra sesión y vuelve a entrar marcando la casilla de Search Console |
| *invalid_client* en el navegador | El ID o el secreto no coinciden, o el cliente no es de tipo *App de escritorio* |

## Desarrollo

```bash
npm install
npm run typecheck
npm test          # tests unitarios
npm run test:e2e  # flujo completo contra un Google simulado (OAuth + API)
npm run pack      # genera el .mcpb
```

Licencia [MIT](LICENSE) · Hecho por [Rafa Villaplana](https://rafavillaplana.com). Compañero de [bing-webmaster-tools-mcp](https://github.com/rafavillaplana/bing-webmaster-tools-mcp).

*No afiliado a Google. Google Search Console es una marca de Google LLC.*
