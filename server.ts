import express, { Request, Response } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { db } from './src/server/db.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Helper to get active user from request header or query
const getReqUser = (req: Request) => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return null;
  return db.getUserById(userId);
};

// ==========================================
// 1. AUTHENTICATION & OTP
// ==========================================

// Request 6-digit OTP
app.post('/api/auth/send-otp', (req: Request, res: Response) => {
  try {
    const { mobile, role } = req.body;
    if (!mobile || !/^\d{10}$/.test(mobile.trim())) {
      res.status(400).json({ error: 'Please enter a valid 10-digit mobile number' });
      return;
    }

    const cleanMobile = mobile.trim();
    // Generate secure 6-digit OTP
    const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
    db.setOtp(cleanMobile, generatedOtp, role);

    console.log(`[SMS Gateway Simulated] OTP sent to ${cleanMobile}: ${generatedOtp}`);

    // In production without external SMS provider, debugOtp helps demo/test seamlessly
    res.json({
      success: true,
      message: `OTP sent successfully to +91 ${cleanMobile}`,
      debugOtp: generatedOtp,
      expiresInSeconds: 300
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Verify OTP and Login/Register
app.post('/api/auth/verify-otp', (req: Request, res: Response) => {
  try {
    const { mobile, otp, name, email, role } = req.body;
    if (!mobile || !otp) {
      res.status(400).json({ error: 'Mobile number and OTP are required' });
      return;
    }

    const cleanMobile = mobile.trim();
    const cleanOtp = otp.trim();

    // Verify OTP
    const isValid = db.verifyOtp(cleanMobile, cleanOtp);
    if (!isValid) {
      res.status(401).json({ error: 'Invalid or expired OTP. Please enter the correct 6-digit code.' });
      return;
    }

    // Check if this is the admin mobile
    const settings = db.getSettings();
    const isAdminMobile = cleanMobile === settings.adminMobile;

    let user = db.getUserByMobile(cleanMobile);

    if (!user) {
      // Create user
      user = db.createUser({
        name: name?.trim() || (isAdminMobile ? 'Nisuu Mart Super Admin' : `User ${cleanMobile.slice(-4)}`),
        mobile: cleanMobile,
        email: email?.trim(),
        role: isAdminMobile ? 'admin' : (role === 'seller' ? 'seller' : 'customer')
      });
    } else {
      // If mobile is admin mobile, enforce admin role
      if (isAdminMobile && user.role !== 'admin') {
        user.role = 'admin';
        db.updateUser(user.id, { role: 'admin' });
      }
    }

    let seller = null;
    if (user.role === 'seller') {
      seller = db.getSellerByUserId(user.id);
    }

    res.json({
      success: true,
      user,
      seller,
      token: `auth-${user.id}-${Date.now()}`
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Google Login endpoint
app.post('/api/auth/google-login', (req: Request, res: Response) => {
  try {
    const { email, name, avatar } = req.body;
    if (!email) {
      res.status(400).json({ error: 'Google email is required' });
      return;
    }

    const allUsers = db.getAllUsers();
    let user = allUsers.find(u => u.email?.toLowerCase() === email.toLowerCase());

    if (!user) {
      user = db.createUser({
        name: name || email.split('@')[0],
        email,
        mobile: '9' + Math.floor(100000000 + Math.random() * 900000000).toString(),
        role: 'customer',
        avatar
      });
    }

    res.json({
      success: true,
      user,
      token: `auth-${user.id}-${Date.now()}`
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get Current User info
app.get('/api/auth/me', (req: Request, res: Response) => {
  const user = getReqUser(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  const seller = user.role === 'seller' ? db.getSellerByUserId(user.id) : null;
  res.json({ user, seller });
});

// ==========================================
// 2. SELLER REGISTRATION & DASHBOARD
// ==========================================

// Register as a seller (immediate selling without admin approval)
app.post('/api/sellers/register', (req: Request, res: Response) => {
  try {
    const { userId, name, mobile, email, shopName, address, upiId } = req.body;

    if (!name || !mobile || !email || !shopName || !address) {
      res.status(400).json({ error: 'Name, mobile, email, shop name, and address are all required.' });
      return;
    }

    let targetUserId = userId;
    if (!targetUserId) {
      let existingUser = db.getUserByMobile(mobile);
      if (!existingUser) {
        existingUser = db.createUser({
          name,
          mobile,
          email,
          role: 'seller'
        });
      } else {
        existingUser.role = 'seller';
        db.updateUser(existingUser.id, { role: 'seller' });
      }
      targetUserId = existingUser.id;
    } else {
      db.updateUser(targetUserId, { role: 'seller' });
    }

    const seller = db.createSeller({
      userId: targetUserId,
      name,
      mobile,
      email,
      shopName,
      address,
      upiId: upiId || db.getSettings().defaultUpiId
    });

    const updatedUser = db.getUserById(targetUserId);

    res.json({
      success: true,
      message: 'Seller account registered successfully! You can start adding products immediately.',
      seller,
      user: updatedUser
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get seller profile & dashboard metrics
app.get('/api/sellers/dashboard', (req: Request, res: Response) => {
  try {
    const sellerId = req.query.sellerId as string;
    const userId = req.headers['x-user-id'] as string;

    let seller = sellerId ? db.getSellerById(sellerId) : undefined;
    if (!seller && userId) {
      seller = db.getSellerByUserId(userId);
    }

    if (!seller) {
      res.status(404).json({ error: 'Seller profile not found' });
      return;
    }

    const products = db.getProducts({ sellerId: seller.id });
    const orders = db.getOrders({ sellerId: seller.id });

    res.json({
      seller,
      products,
      orders,
      metrics: {
        totalProducts: products.length,
        totalOrders: orders.length,
        totalSales: seller.totalSales,
        totalEarnings: seller.totalEarnings,
        totalCommissionPaid: seller.totalCommissionPaid,
        pendingOrders: orders.filter(o => o.orderStatus === 'ORDERED' || o.orderStatus === 'ACCEPTED').length
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Admin get all sellers
app.get('/api/sellers', (_req: Request, res: Response) => {
  res.json(db.getSellers());
});

// Admin toggle block seller
app.post('/api/sellers/:id/toggle-block', (req: Request, res: Response) => {
  try {
    const seller = db.toggleSellerBlock(req.params.id);
    if (!seller) {
      res.status(404).json({ error: 'Seller not found' });
      return;
    }
    res.json({ success: true, seller });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update seller profile (e.g. UPI ID or shop details)
app.put('/api/sellers/:id', (req: Request, res: Response) => {
  try {
    const updated = db.updateSeller(req.params.id, req.body);
    if (!updated) {
      res.status(404).json({ error: 'Seller not found' });
      return;
    }
    res.json({ success: true, seller: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 3. PRODUCTS
// ==========================================

// Get all products with filters
app.get('/api/products', (req: Request, res: Response) => {
  try {
    const { category, brand, sellerId, search, minPrice, maxPrice, sort } = req.query;

    const products = db.getProducts({
      category: category as string,
      brand: brand as string,
      sellerId: sellerId as string,
      search: search as string,
      minPrice: minPrice ? parseFloat(minPrice as string) : undefined,
      maxPrice: maxPrice ? parseFloat(maxPrice as string) : undefined,
      sort: sort as any
    });

    res.json(products);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get single product by ID
app.get('/api/products/:id', (req: Request, res: Response) => {
  const product = db.getProductById(req.params.id);
  if (!product) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  const seller = db.getSellerById(product.sellerId);
  const reviews = db.getProductReviews(product.id);
  res.json({ product, seller, reviews });
});

// Create product (Seller / Admin)
app.post('/api/products', (req: Request, res: Response) => {
  try {
    const {
      sellerId,
      name,
      category,
      brand,
      price,
      discountPrice,
      photos,
      videoUrl,
      description,
      availableSizes,
      availableColors,
      weight,
      returnInfo,
      returnPeriodDays
    } = req.body;

    if (!name || !price || !category) {
      res.status(400).json({ error: 'Product name, category, and price are required.' });
      return;
    }

    const seller = db.getSellerById(sellerId);
    const sellerName = seller?.name || 'Nisuu Mart Seller';
    const sellerShopName = seller?.shopName || 'Nisuu Mart Verified Store';
    const sellerUpiId = seller?.upiId || db.getSettings().defaultUpiId;

    const newProd = db.createProduct({
      sellerId: sellerId || (seller?.id ?? 'seller-damor'),
      sellerName,
      sellerShopName,
      sellerUpiId,
      name,
      category,
      brand: brand || 'Nisuu Mart Select',
      price: parseFloat(price),
      discountPrice: discountPrice ? parseFloat(discountPrice) : parseFloat(price),
      photos: Array.isArray(photos) && photos.length > 0 ? photos : ['https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=800&q=80'],
      videoUrl: videoUrl || undefined,
      description: description || 'High quality product available exclusively on Nisuu Mart.',
      availableSizes: Array.isArray(availableSizes) ? availableSizes : [],
      availableColors: Array.isArray(availableColors) ? availableColors : [],
      weight: weight || '250 grams',
      returnInfo: returnInfo || '7-day return policy for manufacturing defects or sizing issues.',
      returnPeriodDays: returnPeriodDays ? parseInt(returnPeriodDays, 10) : db.getSettings().defaultReturnPeriodDays,
      status: 'active'
    });

    res.json({ success: true, product: newProd });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Update product
app.put('/api/products/:id', (req: Request, res: Response) => {
  try {
    const updated = db.updateProduct(req.params.id, req.body);
    if (!updated) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.json({ success: true, product: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Delete product
app.delete('/api/products/:id', (req: Request, res: Response) => {
  try {
    const success = db.deleteProduct(req.params.id);
    if (!success) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 4. CATEGORIES
// ==========================================

app.get('/api/categories', (_req: Request, res: Response) => {
  res.json(db.getCategories());
});

app.post('/api/categories', (req: Request, res: Response) => {
  try {
    const { name, icon, description } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Category name is required' });
      return;
    }
    const category = db.addCategory({ name, icon, description, active: true });
    res.json({ success: true, category });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/categories/:id', (req: Request, res: Response) => {
  try {
    const cat = db.updateCategory(req.params.id, req.body);
    if (!cat) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    res.json({ success: true, category: cat });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/categories/:id', (req: Request, res: Response) => {
  try {
    const ok = db.deleteCategory(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 5. ORDERS & CHECKOUT
// ==========================================

// Create order (Customer Buy Now or Cart Checkout)
app.post('/api/orders', (req: Request, res: Response) => {
  try {
    const { customerId, customerName, customerMobile, shippingAddress, items, paymentMethod, paymentDetails } = req.body;

    if (!items || !items.length) {
      res.status(400).json({ error: 'At least one item is required in the order.' });
      return;
    }
    if (!shippingAddress || !shippingAddress.fullName || !shippingAddress.pinCode) {
      res.status(400).json({ error: 'Complete delivery address is required.' });
      return;
    }

    const order = db.createOrder({
      customerId: customerId || 'user-customer-1',
      customerName: customerName || shippingAddress.fullName,
      customerMobile: customerMobile || shippingAddress.mobile,
      shippingAddress,
      items,
      paymentMethod,
      paymentDetails
    });

    res.json({ success: true, order });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Get orders (filtered by customerId or sellerId)
app.get('/api/orders', (req: Request, res: Response) => {
  try {
    const { customerId, sellerId } = req.query;
    const orders = db.getOrders({
      customerId: customerId as string,
      sellerId: sellerId as string
    });
    res.json(orders);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Get single order
app.get('/api/orders/:id', (req: Request, res: Response) => {
  const order = db.getOrderById(req.params.id);
  if (!order) {
    res.status(404).json({ error: 'Order not found' });
    return;
  }
  res.json(order);
});

// Update order status (Seller or Admin)
app.put('/api/orders/:id/status', (req: Request, res: Response) => {
  try {
    const { status, deliveryMethod, shipmentDetails, cancellationReason } = req.body;
    const updated = db.updateOrderStatus(req.params.id, status, {
      deliveryMethod,
      shipmentDetails,
      cancellationReason
    });
    if (!updated) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }
    res.json({ success: true, order: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 6. RETURNS & REPLACEMENTS
// ==========================================

app.get('/api/returns', (req: Request, res: Response) => {
  try {
    const { customerId, sellerId } = req.query;
    const returns = db.getReturns({
      customerId: customerId as string,
      sellerId: sellerId as string
    });
    res.json(returns);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/returns', (req: Request, res: Response) => {
  try {
    const { orderId, customerId, type, reason, detailedNotes, photoProofUrl } = req.body;
    const returnReq = db.createReturnRequest({
      orderId,
      customerId,
      type,
      reason,
      detailedNotes,
      photoProofUrl
    });
    res.json({ success: true, returnRequest: returnReq });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/returns/:id/resolve', (req: Request, res: Response) => {
  try {
    const { status, adminNotes } = req.body;
    const resolved = db.resolveReturnRequest(req.params.id, status, adminNotes);
    if (!resolved) {
      res.status(404).json({ error: 'Return request not found' });
      return;
    }
    res.json({ success: true, returnRequest: resolved });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 7. CUSTOMER WALLET & WITHDRAWALS
// ==========================================

app.get('/api/wallet', (req: Request, res: Response) => {
  try {
    const userId = (req.query.userId as string) || (req.headers['x-user-id'] as string);
    if (!userId) {
      res.status(400).json({ error: 'User ID is required' });
      return;
    }
    const wallet = db.getOrCreateWallet(userId);
    const transactions = db.getWalletTransactions(userId);
    const withdrawals = db.getWithdrawals(userId);
    res.json({ wallet, transactions, withdrawals });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Wallet Top-up with UPI UTR verification
app.post('/api/wallet/topup', (req: Request, res: Response) => {
  try {
    const { userId, amount, utrNumber, payerUpi } = req.body;
    const parsedAmount = parseFloat(amount);

    if (isNaN(parsedAmount) || parsedAmount < 10) {
      res.status(400).json({ error: 'Minimum top-up amount is ₹10' });
      return;
    }
    if (!utrNumber || utrNumber.trim().length < 6) {
      res.status(400).json({ error: 'Valid 12-digit UPI UTR / Reference number is required' });
      return;
    }

    const txn = db.creditWallet(
      userId,
      parsedAmount,
      'TOPUP',
      `UPI Top-up (Ref: ${utrNumber}${payerUpi ? ' from ' + payerUpi : ''})`,
      utrNumber
    );

    const wallet = db.getOrCreateWallet(userId);
    res.json({ success: true, transaction: txn, wallet });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Customer Withdrawal Request
app.post('/api/wallet/withdraw', (req: Request, res: Response) => {
  try {
    const { userId, userName, userMobile, amount, upiId, bankAccountNumber, ifsc, accountHolderName } = req.body;

    if (!upiId && (!bankAccountNumber || !ifsc)) {
      res.status(400).json({ error: 'Either UPI ID or Bank Account Number + IFSC code is required.' });
      return;
    }

    const withdrawal = db.createWithdrawalRequest({
      userId,
      userName: userName || 'Nisuu Mart Customer',
      userMobile: userMobile || '9999999999',
      amount: parseFloat(amount),
      upiId,
      bankAccountNumber,
      ifsc,
      accountHolderName
    });

    const wallet = db.getOrCreateWallet(userId);
    res.json({ success: true, withdrawal, wallet });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Admin view all withdrawals
app.get('/api/admin/withdrawals', (_req: Request, res: Response) => {
  res.json(db.getWithdrawals());
});

// Admin process withdrawal
app.put('/api/admin/withdrawals/:id/process', (req: Request, res: Response) => {
  try {
    const { status, adminNotes, payoutRef } = req.body;
    const processed = db.processWithdrawal(req.params.id, status, adminNotes, payoutRef);
    if (!processed) {
      res.status(404).json({ error: 'Withdrawal not found' });
      return;
    }
    res.json({ success: true, withdrawal: processed });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 8. REVIEWS
// ==========================================

app.get('/api/reviews/:productId', (req: Request, res: Response) => {
  res.json(db.getProductReviews(req.params.productId));
});

app.post('/api/reviews', (req: Request, res: Response) => {
  try {
    const { productId, customerId, customerName, rating, title, comment, photoUrl } = req.body;
    if (!productId || !rating || !comment) {
      res.status(400).json({ error: 'Product ID, rating, and review text are required.' });
      return;
    }
    const review = db.addReview({
      productId,
      customerId: customerId || 'user-customer-1',
      customerName: customerName || 'Verified Buyer',
      rating: parseInt(rating, 10),
      title: title || 'Verified Purchase Review',
      comment,
      photoUrl
    });
    res.json({ success: true, review });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 9. ADDRESSES
// ==========================================

app.get('/api/addresses', (req: Request, res: Response) => {
  const userId = (req.query.userId as string) || (req.headers['x-user-id'] as string) || 'user-customer-1';
  res.json(db.getUserAddresses(userId));
});

app.post('/api/addresses', (req: Request, res: Response) => {
  try {
    const addr = db.addAddress(req.body);
    res.json({ success: true, address: addr });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/addresses/:id', (req: Request, res: Response) => {
  try {
    db.deleteAddress(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// 10. SETTINGS & ADMIN STATS
// ==========================================

app.get('/api/settings', (_req: Request, res: Response) => {
  res.json(db.getSettings());
});

app.put('/api/settings', (req: Request, res: Response) => {
  try {
    const updated = db.updateSettings(req.body);
    res.json({ success: true, settings: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stats', (_req: Request, res: Response) => {
  res.json(db.getMarketplaceStats());
});

// ==========================================
// VITE DEV SERVER / STATIC PRODUCTION SERVING
// ==========================================

async function startServer() {
  if (process.env.NODE_ENV === 'production') {
    // Serve static files from Vite build output
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  } else {
    // Use Vite Dev Server middleware
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Nisuu Mart server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
