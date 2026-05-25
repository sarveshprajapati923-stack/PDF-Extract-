// ============================================================
// WePDFHub — Firebase Tools Loader
// Ye file tumhari index.html se tools Firebase se load karegi
// Admin panel se tool add karo — website pe auto show hoga!
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore, collection, getDocs, query, orderBy, doc, updateDoc, increment } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ⚠️ APNA FIREBASE CONFIG YAHAN PASTE KARO
const firebaseConfig = {
  apiKey: "AIzaSyDN9QEaGDaE5oyE6pKgetdc56hKg-RQ6SA",
  authDomain: "wepdfhub-admin.firebaseapp.com",
  projectId: "wepdfhub-admin",
  storageBucket: "wepdfhub-admin.firebasestorage.app",
  messagingSenderId: "888364577342",
  appId: "1:888364577342:web:cbb2117a209b8ff561976f",
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// Tool use track karne ka function — har tool page pe call hoga
window.trackToolUse = async function(slug) {
  try {
    const snap = await getDocs(collection(db, 'tools'));
    snap.forEach(async d => {
      if (d.data().slug === slug) {
        await updateDoc(doc(db, 'tools', d.id), { uses: increment(1) });
      }
    });
  } catch(e) {}
};

// Firebase se tools load karo
async function loadFirebaseTools() {
  try {
    const q = query(collection(db, 'tools'), orderBy('order', 'asc'));
    const snap = await getDocs(q);
    const fbTools = [];
    snap.forEach(d => fbTools.push({ id: d.id, ...d.data() }));

    // Sirf active tools lo
    const activeTools = fbTools.filter(t => t.status === 'active');
    if (!activeTools.length) return; // Firebase mein tools nahi hain — default show hoga

    // Existing grid dhundo
    const grid = document.getElementById('grid');
    if (!grid) return;

    // Firebase tools ko existing format mein convert karo
    const icons = {
      "merge-pdf":"⚡","split-pdf":"✂️","compress-pdf":"🗜️","rotate-pdf":"🔄",
      "watermark-pdf":"💧","delete-pages":"🗑️","extract-pages":"📤","reorder-pages":"🔀",
      "image-to-pdf":"🖼️","pdf-to-word":"📄","pdf-to-jpg":"📷","ocr-pdf":"👁️",
      "extract-text":"📝","protect-pdf":"🔒","unlock-pdf":"🔓","pdf-to-excel":"📊",
      "pdf-info":"ℹ️","page-number":"🔢","add-header":"⬆️","add-footer":"⬇️"
    };

    // Categories group karo
    const categories = {
      'Convert': { label: 'Convert PDF', tools: [] },
      'Edit':    { label: 'Organize PDF', tools: [] },
      'Organize':{ label: 'Organize PDF', tools: [] },
      'Security':{ label: 'Security', tools: [] },
      'Compress':{ label: 'Compress PDF', tools: [] },
      'Other':   { label: 'Other Tools', tools: [] }
    };

    activeTools.forEach(t => {
      const cat = t.category || 'Other';
      if (!categories[cat]) categories[cat] = { label: cat, tools: [] };
      categories[cat].tools.push(t);
    });

    // Grid clear karke Firebase tools render karo
    grid.innerHTML = '';

    Object.values(categories).forEach(cat => {
      if (!cat.tools.length) return;

      const section = document.createElement('section');
      section.className = 'section-block';
      section.innerHTML = `
        <div class="section-head">
          <h2>${cat.label}</h2>
          <span class="count">${cat.tools.length} tools</span>
        </div>
        <div class="grid"></div>
      `;

      const innerGrid = section.querySelector('.grid');
      cat.tools.forEach(t => {
        const el = document.createElement('a');
        el.href   = t.url || '/' + t.slug;
        el.className = 'tool-card';
        el.innerHTML = `
          <div class="tool-ico">${t.emoji || icons[t.slug] || '📄'}</div>
          <div>
            <h3>${t.name}</h3>
            <p>${t.description || ''}</p>
          </div>
        `;
        // Click pe usage track karo
        el.addEventListener('click', () => {
          window.trackToolUse(t.slug);
        });
        innerGrid.appendChild(el);
      });

      grid.appendChild(section);
    });

    console.log('✅ WePDFHub: Firebase se', activeTools.length, 'tools load ho gaye!');

  } catch(e) {
    // Firebase error aane par default tools dikhne denge
    console.log('Firebase tools load nahi hue, default use ho raha hai:', e.message);
  }
}

// Page load hone ke baad run karo
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadFirebaseTools);
} else {
  loadFirebaseTools();
}
