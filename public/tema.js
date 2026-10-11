// Tema claro u oscuro. «auto» sigue al sistema (y cambia solo si cambia el sistema).
// Se carga en <head>, antes de pintar, para que la página no aparezca un instante con el otro tema.
(() => {
  const SISTEMA = matchMedia("(prefers-color-scheme: light)");
  const leer = () => {
    try {
      return localStorage.getItem("orbita.tema") || "auto";
    } catch {
      return "auto";
    }
  };
  const aplicar = () => {
    const t = leer();
    document.documentElement.dataset.theme = t === "auto" ? (SISTEMA.matches ? "light" : "dark") : t;
  };
  aplicar();
  SISTEMA.addEventListener("change", aplicar);
  window.temaOrbita = {
    leer,
    poner(t) {
      try {
        localStorage.setItem("orbita.tema", t);
      } catch {}
      aplicar();
    },
  };
})();
