import React from 'react';

export default function DrinkMenuWebsite() { const [title, setTitle] = React.useState("Itallap"); const [items, setItems] = React.useState([ { id: 1, name: "Espresso", price: "650 Ft" }, { id: 2, name: "Cappuccino", price: "950 Ft" }, { id: 3, name: "Mojito", price: "2 500 Ft" }, ]);

const updateItem = (id, field, value) => { setItems((prev) => prev.map((item) => item.id === id ? { ...item, [field]: value } : item ) ); };

const addItem = () => { setItems((prev) => [ ...prev, { id: Date.now(), name: "Új ital", price: "0 Ft", }, ]); };

const removeItem = (id) => { setItems((prev) => prev.filter((item) => item.id !== id)); };

return ( <div className="min-h-screen bg-gradient-to-br from-zinc-900 to-zinc-800 text-white p-6"> <div className="max-w-4xl mx-auto"> <div className="bg-zinc-950/70 backdrop-blur-md rounded-3xl shadow-2xl p-8 border border-zinc-700"> <input value={title} onChange={(e) => setTitle(e.target.value)} className="w-full text-4xl font-bold bg-transparent border-b border-zinc-600 pb-3 outline-none text-center" />

<p className="text-zinc-400 text-center mt-3 mb-8">
        Szerkeszthető ital- és árlista weboldal
      </p>

      <div className="space-y-4">
        {items.map((item) => (
          <div
            key={item.id}
            className="grid grid-cols-1 md:grid-cols-3 gap-3 bg-zinc-800 rounded-2xl p-4 items-center"
          >
            <input
              value={item.name}
              onChange={(e) =>
                updateItem(item.id, "name", e.target.value)
              }
              className="bg-zinc-900 rounded-xl px-4 py-3 outline-none border border-zinc-700 focus:border-yellow-400"
              placeholder="Ital neve"
            />

            <input
              value={item.price}
              onChange={(e) =>
                updateItem(item.id, "price", e.target.value)
              }
              className="bg-zinc-900 rounded-xl px-4 py-3 outline-none border border-zinc-700 focus:border-yellow-400"
              placeholder="Ár"
            />

            <button
              onClick={() => removeItem(item.id)}
              className="bg-red-500 hover:bg-red-600 transition rounded-xl px-4 py-3 font-semibold"
            >
              Törlés
            </button>
          </div>
        ))}
      </div>

      <div className="mt-8 flex flex-col md:flex-row gap-4">
        <button
          onClick={addItem}
          className="flex-1 bg-yellow-400 hover:bg-yellow-300 text-black font-bold py-4 rounded-2xl transition"
        >
          + Új ital hozzáadása
        </button>

        <button
          onClick={() => window.print()}
          className="flex-1 bg-white/10 hover:bg-white/20 border border-zinc-700 py-4 rounded-2xl transition"
        >
          Itallap nyomtatása
        </button>
      </div>
    </div>

    <footer className="text-center text-zinc-500 mt-8 text-sm">
      Készítve szerkeszthető itallaphoz
    </footer>
  </div>
</div>

); }