@echo off
echo.
echo  Corretor OMR — Servidor local
echo  ==============================
echo  Acesse: http://localhost:8000
echo  Para camara, use HTTPS ou acesse por localhost (Chrome/Edge permite).
echo.
echo  Pressione Ctrl+C para parar.
echo.

:: Tenta Python 3
python -m http.server 8000 2>nul
if %errorlevel% neq 0 (
  :: Tenta Python 2
  python2 -m SimpleHTTPServer 8000 2>nul
  if %errorlevel% neq 0 (
    :: Tenta npx serve
    npx serve -l 8000
  )
)
pause
