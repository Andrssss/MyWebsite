import React, { useEffect, useRef } from 'react';

const FireParticlesCanvas = ({ active }) => {
  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const particles = useRef([]); 

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const maxParticles = 250000;

    const createParticle = () => {
      if (!active) return; // Ha inaktív, ne hozzon létre új részecskéket

      if (particles.current.length < maxParticles) {
        const isSmallScreen = window.innerWidth < 768;
        const size = isSmallScreen ? Math.random() * 10 + 3 : Math.random() * 6 + 3;
        const life = isSmallScreen ? Math.random() * 60 + 130 : Math.random() * 60 + 120;
        const y = isSmallScreen ? canvas.height + 13 : canvas.height + 5;

        particles.current.push({
          x: Math.random() * canvas.width,
          y: y,
          size: size,
          opacity: Math.random() * 0.5 + 0.5,
          speedY: Math.random() * 1.5 + 0,
          speedX: (Math.random() - 0.5) * 0.5,
          life: life,
          age: 0,
          color: [255, Math.random() * 150 + 50, 0],
        });
      }
    };

    const updateParticles = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particles.current.forEach((particle, index) => {
        if (active) {
          particle.y -= particle.speedY * 2; 
          particle.x += particle.speedX;
          particle.age++;

          particle.size *= 0.994;
          particle.opacity *= 0.99;

          particle.color[1] -= 4; 
        }

        if (particle.age >= particle.life || particle.opacity <= 0) {
          particles.current.splice(index, 1);
        } else {
          ctx.beginPath();
          ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${Math.floor(particle.color[0])}, ${Math.floor(particle.color[1])}, ${Math.floor(particle.color[2])}, ${particle.opacity})`;
          ctx.fill();
        }
      });
    };

    const loop = () => {
      if (active) {
        for (let i = 0; i < 10; i++) {
          createParticle();
        }
      }
      
      updateParticles();
      animationRef.current = requestAnimationFrame(loop);
    };

    // Canvas méretének beállítása
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    loop();

    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', resizeCanvas);

    return () => {
      window.removeEventListener('resize', resizeCanvas);
      cancelAnimationFrame(animationRef.current);
    };
  }, [active]); 

  // 👉 **Ha `active` false lesz, azonnal töröljük a részecskéket és a canvas tartalmát**
  useEffect(() => {
    if (!active) {
      particles.current = []; // Az összes részecske törlése
      const ctx = canvasRef.current.getContext('2d');
      ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height); // Canvas törlése
    }
  }, [active]);

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
