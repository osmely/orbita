// Órbita · la interfaz del tablero, en módulos. Todo el estado vive en el servidor; aquí se pinta y se
// escuchan sus cambios en vivo (ver nucleo.js). Cada módulo prepara lo suyo con iniciarModulo(), en este orden.
import { iniciarModulo as iniciarNucleo } from "./nucleo.js";
import { iniciarModulo as iniciarTablero } from "./tablero.js";
import { iniciarModulo as iniciarPaginas } from "./paginas.js";
import { iniciarModulo as iniciarPanel } from "./panel.js";
import { iniciarModulo as iniciarAcciones } from "./acciones.js";
import { iniciarModulo as iniciarBusqueda } from "./busqueda.js";
import { iniciarModulo as iniciarExportar } from "./exportar.js";

iniciarNucleo();
iniciarTablero();
iniciarPaginas();
iniciarPanel();
iniciarAcciones();
iniciarBusqueda();
iniciarExportar();
