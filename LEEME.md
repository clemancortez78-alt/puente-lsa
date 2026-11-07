# Puente LSA — app de comunicación persona sorda ↔ persona oyente

App web instalable (PWA) para Android y iPhone. Hace dos cosas:

1. **Señas → texto y voz.** La persona sorda hace señas frente a la cámara, la app las reconoce, arma la frase y la lee en voz alta.
2. **Voz → texto.** La persona oyente habla y su respuesta aparece escrita en letra grande. Hay un modo pantalla completa que se puede girar 180° para leerlo del otro lado de la mesa.

Todo se procesa en el celular: no se mandan imágenes ni audios a ningún servidor.

## Publicarla (gratis, 10 minutos)

La cámara y el micrófono solo funcionan con **https**, así que hay que subir la carpeta a un hosting. Hay dos opciones:

**Opción A: Netlify (la más fácil)**
1. Crear una cuenta gratis en https://app.netlify.com
2. Ir a *Sites → Add new site → Deploy manually*.
3. Arrastrar la carpeta `puente-lsa` completa.
4. Netlify te da una dirección del tipo `https://puente-lsa-xxxx.netlify.app`. Esa es la app.

**Opción B: GitHub Pages**
1. Crear un repositorio y subir el contenido de la carpeta.
2. *Settings → Pages → Deploy from branch → main / root*.

## Instalarla en el celular

- **Android (Chrome):** abrir la dirección → menú ⋮ → *Instalar app*.
- **iPhone (Safari):** abrir la dirección → Compartir → *Agregar a inicio*.

La primera vez necesita internet para bajar el modelo de manos (unos 7 MB). Después queda guardado.
Si querés que funcione **100% sin internet**, bajá `hand_landmarker.task` desde
https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
y copialo en `models/hand_landmarker.task` antes de publicar.

## Primer uso: entrenar las señas

La app no trae un "diccionario LSA" ya entrenado. No existe uno abierto y confiable para la Lengua de Señas Argentina. Por eso **aprende las señas de quien la usa**:

1. Pestaña **Entrenar señas** → encender la cámara.
2. Tocar **Grabar** en una palabra. Cada vez que aparezca **"¡Ahora!"**, hacer la seña completa (dura 1 segundo).
3. Grabar 10–15 ejemplos por seña, con variaciones naturales: un poco más cerca, más lejos, con más o menos luz.
4. Probar en **Conversar**. Si confunde señas, grabar más ejemplos de esas dos o ajustar la exigencia.
5. **Exportar** guarda el entrenamiento en un archivo, que se puede **Importar** en otro celular.

Consejo: conviene que la persona sorda arme su vocabulario con las 20–40 frases o palabras que más usa en su día a día (trabajo, salud, trámites).

## Cómo funciona (técnico)

- Detección de manos: MediaPipe Hand Landmarker (incluido en `vendor/`), 21 puntos por mano, hasta 2 manos.
- Cada seña es una secuencia de 1 segundo remuestreada a 6 cuadros. Se normaliza la forma de la mano respecto de la muñeca y su tamaño, más la posición de la mano en la imagen. Así se reconocen señas quietas y con movimiento.
- Clasificador k-vecinos con un umbral propio por seña, para rechazar gestos que no se entrenaron.
- Voz a texto: Web Speech API (`es-AR`). Texto a voz: `speechSynthesis`.
- Datos guardados en IndexedDB del navegador.

## Próximos pasos posibles

- **Publicar en Play Store / App Store:** cargar la dirección https en https://www.pwabuilder.com. Genera el paquete Android (y el proyecto iOS) a partir de esta misma app.
- **Validar con usuarios sordos** y, si se puede, con intérpretes de LSA o una asociación local de personas sordas.
- **Reconocimiento de frases continuas:** requiere entrenar un modelo con un corpus de LSA (por ejemplo LSA64 de la UNLP, que tiene 64 señas). Es un proyecto aparte, de investigación.
