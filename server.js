// ✅ استيراد المكتبات الأساسية
import express from "express";
import bodyParser from "body-parser";
import twilio from "twilio";
import dotenv from "dotenv";
import admin from "firebase-admin";

// تحميل متغيرات البيئة
dotenv.config();

// ================================
// 🔐 التحقق من المتغيرات البيئية
// ================================
const requiredEnvVars = [
  'FIREBASE_KEY',
  'TWILIO_SID', 
  'TWILIO_AUTH'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ المتغير البيئي ${envVar} غير موجود`);
    process.exit(1);
  }
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

  // إصلاح مشكلة private_key \n
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }

} catch (error) {
  console.error('❌ خطأ في تحليل FIREBASE_KEY:', error.message);
  process.exit(1);
}


// ================================
// 🚀 تهيئة التطبيقات
// ================================
const app = express();
app.use(bodyParser.json());

// تهيئة Firebase Admin
try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log('✅ Firebase Admin initialized successfully');
} catch (error) {
  console.error('❌ خطأ في تهيئة Firebase:', error.message);
  process.exit(1);
}

// إعداد Twilio
const client = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH
);

// تخزين أكواد OTP مؤقتًا مع وقت الانتهاء
const otpStore = new Map();

// ================================
// ⏰ وظيفة تنظيف OTPs المنتهية
// ================================
const cleanExpiredOTPs = () => {
  const now = Date.now();
  for (const [phone, data] of otpStore.entries()) {
    if (now > data.expiresAt) {
      otpStore.delete(phone);
      console.log(`🧹 تم تنظيف OTP للرقم: ${phone}`);
    }
  }
};

// تنظيف كل 5 دقائق
setInterval(cleanExpiredOTPs, 5 * 60 * 1000);

// ================================
// 📤 إرسال OTP عبر واتساب
// ================================
app.post("/send-otp", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ 
        ok: false, 
        error: "رقم الهاتف مطلوب" 
      });
    }

    // تنظيف رقم الهاتف
    const cleanPhone = phone.replace(/\s+/g, '').trim();
    
    // التحقق من صحة رقم الهاتف
    if (!cleanPhone.match(/^\+?[1-9]\d{1,14}$/)) {
      return res.status(400).json({ 
        ok: false, 
        error: "رقم الهاتف غير صحيح" 
      });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 دقائق

    console.log(`📤 إرسال كود ${otp} إلى ${cleanPhone}`);

    await client.messages.create({
      from: "whatsapp:+14155238886",
      to: `whatsapp:${cleanPhone}`,
      body: `🔐 رمز التحقق الخاص بك لتطبيق يمن نقل هو: ${otp}\n\n⏰ هذا الرمز صالح لمدة 10 دقائق.`,
    });

    // حفظ OTP مع وقت الانتهاء
    otpStore.set(cleanPhone, {
      otp,
      expiresAt,
      attempts: 0
    });

    res.json({ 
      ok: true, 
      message: "✅ تم إرسال كود التحقق إلى واتساب بنجاح" 
    });

  } catch (error) {
    console.error("❌ خطأ أثناء الإرسال:", error.message);
    
    let errorMessage = "حدث خطأ أثناء الإرسال";
    if (error.code === 21211) {
      errorMessage = "رقم الهاتف غير صحيح";
    } else if (error.code === 21408) {
      errorMessage = "الخدمة غير مفعلة لرقم الهاتف هذا";
    }
    
    res.status(500).json({ 
      ok: false, 
      error: errorMessage 
    });
  }
});

// ================================
// 🧩 التحقق من كود OTP
// ================================
app.post("/verify-otp", async (req, res) => {
  try {
    const { phone, code } = req.body;

    if (!phone || !code) {
      return res.status(400).json({ 
        ok: false, 
        error: "رقم الهاتف والكود مطلوبان" 
      });
    }

    const cleanPhone = phone.replace(/\s+/g, '').trim();
    const otpData = otpStore.get(cleanPhone);

    console.log(`🧩 تحقق من ${cleanPhone} بالكود ${code}`);

    if (!otpData) {
      return res.status(400).json({ 
        ok: false, 
        error: "❌ لم يتم إرسال كود تحقق لهذا الرقم" 
      });
    }

    // التحقق من انتهاء الصلاحية
    if (Date.now() > otpData.expiresAt) {
      otpStore.delete(cleanPhone);
      return res.status(400).json({ 
        ok: false, 
        error: "❌ انتهت صلاحية كود التحقق" 
      });
    }

    // زيادة عدد المحاولات
    otpData.attempts += 1;

    // التحقق من تجاوز الحد الأقصى للمحاولات
    if (otpData.attempts > 5) {
      otpStore.delete(cleanPhone);
      return res.status(400).json({ 
        ok: false, 
        error: "❌ تم تجاوز الحد الأقصى للمحاولات" 
      });
    }

    if (otpData.otp === code) {
      otpStore.delete(cleanPhone);
      res.json({ 
        ok: true, 
        message: "✅ تم التحقق بنجاح" 
      });
    } else {
      res.status(400).json({ 
        ok: false, 
        error: `❌ كود غير صحيح (${otpData.attempts}/5)` 
      });
    }

  } catch (error) {
    console.error("❌ خطأ أثناء التحقق:", error.message);
    res.status(500).json({ 
      ok: false, 
      error: "حدث خطأ أثناء التحقق" 
    });
  }
});

// ================================
// 🔐 إرسال رابط إعادة تعيين كلمة المرور
// ================================
app.post("/send-reset-link", async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone) {
      return res.status(400).json({ 
        ok: false, 
        error: "رقم الهاتف مطلوب" 
      });
    }

    const cleanPhone = phone.replace(/\s+/g, '').trim();
    const email = `${cleanPhone}@naql.com`;

    console.log(`📤 إرسال رابط إعادة التعيين إلى ${cleanPhone}`);

    // توليد رابط إعادة التعيين من Firebase
    const resetLink = await admin.auth().generatePasswordResetLink(email, {
      url: "https://yemen-naql-server.onrender.com/reset-password", // 🔄 غير هذا الرابط
      handleCodeInApp: true
    });

    await client.messages.create({
      from: "whatsapp:+14155238886",
      to: `whatsapp:${cleanPhone}`,
      body: `🔐 لإعادة تعيين كلمة المرور في تطبيق يمن نقل، اضغط على الرابط التالي:\n${resetLink}\n\n⏰ الرابط صالح لمدة 24 ساعة.`,
    });

    res.json({ 
      ok: true, 
      message: "✅ تم إرسال رابط إعادة التعيين إلى واتساب بنجاح" 
    });

  } catch (error) {
    console.error("❌ خطأ أثناء إرسال الرابط:", error.message);
    
    let errorMessage = "حدث خطأ أثناء إرسال الرابط";
    if (error.code === 'auth/user-not-found') {
      errorMessage = "لم يتم العثور على حساب مرتبط بهذا الرقم";
    }
    
    res.status(500).json({ 
      ok: false, 
      error: errorMessage 
    });
  }
});

// ================================
// 🩺 نقطة فحص صحة السيرفر
// ================================
app.get("/health", (req, res) => {
  res.json({ 
    ok: true, 
    message: "✅ السيرفر يعمل بشكل طبيعي",
    timestamp: new Date().toISOString()
  });
});

// ================================
// 🚀 تشغيل السيرفر
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log("📡 جاهز لاستقبال الطلبات من تطبيق يمن نقل ✅");
  console.log("🔧 الوضع:", process.env.NODE_ENV || 'development');
});

// معالجة الأخطاء غير المتوقعة
process.on('unhandledRejection', (error) => {
  console.error('❌ خطأ غير معالج:', error);
});

process.on('uncaughtException', (error) => {
  console.error('❌ استثناء غير معالج:', error);
  process.exit(1);
});
