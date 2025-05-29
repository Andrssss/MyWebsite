import React, { useEffect, useRef } from 'react';

const FireParticlesCanvas = ({ active }) => {
  const canvasRef = useRef(null);
  const animationRef = useRef(null);
  const particles = useRef([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const maxParticles = 20000;

    const createParticle = () => {
      if (!active) return; // Ha inaktív, ne hozzon létre új részecskéket

      if (particles.current.length < maxParticles) {
        const isSmallScreen = window.innerWidth < 768;
        const size = isSmallScreen ? Math.random() * 6 + 10 : Math.random() * 6 + 25;
        const life = isSmallScreen ? Math.random() * 60 + 150 : Math.random() * 60 + 300;
        const y = isSmallScreen ? canvas.height + 5 : canvas.height + 19;

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

      particles.current = particles.current.filter((particle) => {
        particle.y -= particle.speedY * 2;
        particle.x += particle.speedX* 1.5;
        particle.age++;
        
        if (particles.current.length < maxParticles) {
          const isSmallScreen = window.innerWidth < 768;
          if (particle.size < 8) {
            particle.size *= isSmallScreen ? 0.96 : 0.94;  // gyorsabb zsugorodás
            particle.opacity *= isSmallScreen ? 0.95 : 0.96; // gyorsabb elhalványulás
          } else {
            particle.size *= isSmallScreen ? 0.995 : 0.99;
            particle.opacity *= isSmallScreen ? 0.99 : 0.994;
          }

          // particle.size *= 0.994;
          // particle.opacity *= 0.99;
        }
        particle.color[1] -= 3;

        if (particle.age >= particle.life || particle.opacity <= 0) {
          return false; // Részecske eltávolítása
        }

        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${Math.floor(particle.color[0])}, ${Math.floor(particle.color[1])}, ${Math.floor(particle.color[2])}, ${particle.opacity})`;
        ctx.fill();

        return true; // Maradjon a tömbben
      });
    };

    const loop = () => {
      if (active) {
        for (let i = 0; i < 3; i++) {
          createParticle();
        }
      }

      updateParticles();
      animationRef.current = requestAnimationFrame(loop);
    };

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
