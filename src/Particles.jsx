import React, { useEffect, useRef } from 'react';

const FireParticlesCanvas = () => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const particles = [];
    const maxParticles = 2500;

    const createParticle = () => {
      if (particles.length < maxParticles) {
        particles.push({
          x: Math.random() * canvas.width, // Random vízszintes pozíció
          y: canvas.height+10 , // Az aljáról indul
          size: Math.random() * 3 + 3, // Részecske mérete
          opacity: Math.random() * 0.5 + 0.5, // Átlátszóság
          speedY: Math.random() * 1.5 + 0, // Függőleges sebesség
          speedX: (Math.random() - 0.5) * 0.5, // Oldalirányú mozgás
          life: Math.random() * 60 + 200, // Élettartam
          age: 0, // Aktuális kor
          color: [255, Math.random() * 150 + 50, 0], // Lángszín (narancssárga-vörös skála)
        });
      }
    };

    const updateParticles = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particles.forEach((particle, index) => {
        particle.y -= particle.speedY*2; // Mozgás felfelé
        particle.x += particle.speedX; // Oldalirányú sodródás
        particle.age++;

        // Lassan csökken a méret és az átlátszóság
        particle.size *= 0.994;
        particle.opacity *= 0.99;

        // Színváltozás sárgából vörös felé
        particle.color[1] -= 4; // Zöld komponens csökken

        // Részecske törlése, ha az élettartama véget ér
        if (particle.age >= particle.life || particle.opacity <= 0) {
          particles.splice(index, 1);
        } else {
          // Részecske kirajzolása
          ctx.beginPath();
          ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${Math.floor(particle.color[0])}, ${Math.floor(particle.color[1])}, ${Math.floor(particle.color[2])}, ${particle.opacity})`;
          ctx.fill();
        }
      });
    };

    const loop = () => {
      for (let i = 0; i < 3; i++) { // Több részecske generálása egy loopban
        createParticle();
      }      
      updateParticles();
      requestAnimationFrame(loop);
    };

    // Méret beállítása
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Loop indítása
    loop();

    // Canvas méretének frissítése, ha az ablak mérete változik
    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', resizeCanvas);

    return () => {
      window.removeEventListener('resize', resizeCanvas);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: 'block',
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: 1,
        pointerEvents: 'none',
      }}
    />
  );
};

export default FireParticlesCanvas;
