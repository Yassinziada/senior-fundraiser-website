// Local UI smoke checks with mocked Supabase responses. SQL authorization is
// verified separately in tests/db/staff-roles.test.js. Never uses production.
// Start Vite with VITE_SUPABASE_URL=http://127.0.0.1:54329 and
// VITE_SUPABASE_ANON_KEY=test-public-key, then run this file with Playwright.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const base = process.env.TEST_APP_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const product = {id: 1, name:'Water', section_code:'BAZAAR', category_id:null, price:15,cost:8,
  stock:10, starting_stock:10, min_stock:2, track_stock:true, active:true};
const supplierId='00000000-0000-4000-8000-000000000003';
const userId='00000000-0000-4000-8000-000000000001';
const totals = Object.fromEntries(['revenue','transactions','units','avg_transaction','cogs','gross_profit','margin_pct','cash','telda','instapay','voided_count','voided_amount'].map(k=>[k,0]));
const report = {totals, ...Object.fromEntries(['by_section','by_payment','by_day','by_hour','by_product','by_category','by_cashier'].map(k=>[k,[]]))};
const errors = [];
try {
 for (const role of ['admin','cashier','finance','product_manager','supplier']) {
  const context=await browser.newContext();
  const page=await context.newPage();
  page.on('pageerror', e=>errors.push(`${role}: ${e.message}`));
  const id=role==='supplier'?supplierId:userId;
  const profile={id, username:'testuser',full_name:'Test User',role,active:true,section_code:role==='cashier'?'BAZAAR':null};
  const orders=[{id:'00000000-0000-4000-8000-000000000010',title:'Weekly supplies',supplier_id:supplierId,
    items:[{id:1,product_id:1,product_name:'Water',quantity:5,purchased:0,delivered:0,purchased_at:null,delivered_at:null,received:0}]}];
  const money={started_at:role==='admin'?null:new Date().toISOString(),cash:1000,telda:100,instapay:50,total:1150,starting:1150,sales:0,cogs:0,purchases:0,expenses:0,stock_losses:0,legacy_refunds:0,gross_profit:0,net_profit:0};
  const moneyKeys=new Set(); let loseExpenseResponse=true;
  const calls=[];
  const categories=[];
  await page.route('http://127.0.0.1:54329/**',async route=>{
   const url=new URL(route.request().url());
   const method=route.request().method();
   let data=null;
   if(url.pathname.includes('/auth/v1/token')) {
    const token=[{alg:'HS256',typ:'JWT'},{sub:id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'},{}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.');
    data={access_token:token,refresh_token:'test-refresh',expires_in:3600,token_type:'bearer',user:{id,email:'test@example.com',aud:'authenticated'}};
   } else if(url.pathname.includes('/auth/v1/user')) data={id,email:'test@example.com'};
   else if(url.pathname.includes('/rpc/')) {
    const fn=url.pathname.split('/').at(-1); calls.push(fn);
    if(fn==='public_app_info') data={event_name:'Test fundraiser'};
    else if(fn==='money_summary') data=money;
    else if(fn==='money_open') {
      const a=route.request().postDataJSON();
      Object.assign(money,{started_at:new Date().toISOString(),cash:a.p_cash,telda:a.p_telda,instapay:a.p_instapay,total:a.p_cash+a.p_telda+a.p_instapay,starting:a.p_cash+a.p_telda+a.p_instapay});
    }
    else if(fn==='money_record') {
      const a=route.request().postDataJSON();
      if(!moneyKeys.has(a.p_key)) {
        moneyKeys.add(a.p_key);money[a.p_account.toLowerCase()]-=a.p_amount;
        if(a.p_kind==='expense') {money.total-=a.p_amount;money.expenses+=a.p_amount;money.net_profit-=a.p_amount;}
        else money[a.p_to.toLowerCase()]+=a.p_amount;
      }
      if(a.p_kind==='expense' && loseExpenseResponse) {loseExpenseResponse=false;return route.abort('failed');}
    }
    else if(fn==='admin_sales_report') data=report;
    else if(fn==='admin_inventory_summary') data={low_stock:[],out_of_stock:[],units_in_stock:10,stock_cost_value:80,stock_retail_value:150};
    else if(fn==='admin_products_overview') data=[product];
    else if(fn==='admin_save_category') {
      const args=route.request().postDataJSON();
      if(args.p_name==='Rejected category') return route.fulfill({status:403, contentType:'application/json',
        headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({code:'42501', message:'Category update was refused', hint:'FORBIDDEN'})});
      if(args.p_id===null) {
        data=categories.length+1;
        categories.push({id:data,section_code:args.p_section,name:args.p_name,sort_order:args.p_sort_order,active:args.p_active});
      } else {
        const category=categories.find(c=>c.id===args.p_id);
        Object.assign(category,{name:args.p_name,sort_order:args.p_sort_order,active:args.p_active});
        data=category.id;
      }
    }
    else if(fn==='supplier_confirm_purchase') Object.assign(orders[0].items[0], {purchased:route.request().postDataJSON().p_quantity,purchased_at:new Date().toISOString()});
    else if(fn==='supplier_confirm_delivery') Object.assign(orders[0].items[0], {delivered:route.request().postDataJSON().p_quantity,delivered_at:new Date().toISOString()});
    else if(fn==='money_stock') orders[0].items[0].received+=route.request().postDataJSON().p_quantity;
    else if(fn==='admin_cash_summary') data=[];
   } else {
    const table=url.pathname.split('/').at(-1);
    if(table==='profiles') data=url.searchParams.has('role')?[{id:supplierId,full_name:'Supplier One',username:'supplier1'}]:[profile];
    else if(table==='app_settings') data=[{id:1,event_name:'Test fundraiser',timezone:'Africa/Cairo',currency_code:'EGP',locale:'en-EG'}];
    else if(table==='sections') data=[{code:'BAZAAR',name:'Bazaar',sort_order:0},{code:'SNACKS',name:'Snacks',sort_order:1}];
    else if(table==='products') data=[product];
    else if(table==='categories') data=categories;
    else if(table==='supplier_orders') data=orders;
    else data=[];
    if(route.request().headers()['accept']?.includes('vnd.pgrst.object')) data=data[0]??null;
   }
   await route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*','Content-Range':'0-0/1'},body:method==='HEAD'?'':JSON.stringify(data)});
  });
  await page.goto(base);
  await page.getByRole('textbox',{name:'Username (cashier) or email (staff)'}).fill('test@example.com');
  await page.getByLabel('Password',{exact:true}).fill('testpassword123');
  await page.getByRole('button',{name:/sign in/i}).click();
  const expected=role==='cashier'?'/pos':role==='supplier'?'/supplier':role==='product_manager'?'/admin/products':'/admin';
  await page.waitForURL(base+expected);
  if(role==='admin') {
   await page.getByRole('link',{name:'Money',exact:true}).click();
   await page.getByLabel('Starting Cash',{exact:true}).fill('1000');
   await page.getByLabel('Starting Telda',{exact:true}).fill('100');
   assert.equal(await page.getByLabel('Starting InstaPay',{exact:true}).count(),0);
   await page.getByRole('checkbox').check();
   await page.getByRole('button',{name:'Start money tracking'}).click();
   await page.getByRole('heading',{name:'How the totals add up'}).waitFor();
   await page.getByLabel('Amount',{exact:true}).fill('10');
   await page.getByLabel('Description',{exact:true}).fill('Transport');
   await page.getByRole('button',{name:'Record expense'}).click();
   await page.getByRole('button',{name:'Retry safely'}).waitFor();
   await page.reload();
   await page.getByRole('button',{name:'Retry safely'}).click();
   await page.getByRole('status').filter({hasText:'Saved.'}).waitFor();
   assert.equal(money.total,1090);assert.equal(money.expenses,10);
   assert.deepEqual(await page.getByRole('combobox',{name:'Paid from',exact:true}).locator('option').allTextContents(),['Cash','Telda']);
   await page.getByLabel('Type',{exact:true}).selectOption('transfer');
   assert.deepEqual(await page.getByRole('combobox',{name:'Transfer to',exact:true}).locator('option').allTextContents(),['Cash','Telda']);
   await page.getByLabel('Amount',{exact:true}).fill('100');
   await page.getByLabel('Description',{exact:true}).fill('Move money');
   await page.getByRole('button',{name:'Record transfer'}).click();
   await page.waitForFunction(()=>!document.body.textContent.includes('The last action is unconfirmed'));
   assert.equal(money.total,1090);assert.equal(money.cash,890);assert.equal(money.telda,200);
   await page.setViewportSize({width:390,height:844});
   await page.screenshot({path:'/workspace/work/money-mobile.png',fullPage:true});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Money page fits mobile width');
   await page.setViewportSize({width:1280,height:720});
   console.log('PASS opening balances, expense lost-response recovery across refresh, transfer and combined total');
  }
  if(role==='cashier') {
   await page.locator('.pcard', {has:page.locator('.pname',{hasText:'Water'})}).click();
   await page.getByRole('button',{name:/CHECKOUT/}).click();
   assert.equal(await page.getByRole('radio',{name:'InstaPay',exact:true}).count(),0);
   assert.equal(await page.getByRole('radio').count(),2);
   await page.getByRole('radio',{name:'Telda',exact:true}).click();
   console.log('PASS cashier checkout offers Cash and Telda only');
  }
  if(role==='finance') {
   await page.getByRole('heading',{name:'Dashboard',exact:true}).waitFor();
   assert.deepEqual(await page.locator('nav a').allTextContents(),['Dashboard','Cash handover','Money','Reports']);
   await page.goto(base+'/admin/users'); await page.waitForURL(base+'/admin');
   await page.getByRole('link',{name:'Reports',exact:true}).click();
   await page.getByRole('heading',{name:'Reports',exact:true}).waitFor();
  }
  if(role==='product_manager') {
   await page.getByRole('heading',{name:'Products',exact:true}).waitFor();
   assert.equal(await page.getByRole('link',{name:'Users',exact:true}).count(),0);
   await page.getByRole('link',{name:'Categories',exact:true}).click();
   const bazaarCard=page.getByRole('heading',{name:'Bazaar',exact:true}).locator('..');
   await bazaarCard.getByRole('button',{name:'Add',exact:true}).click();
   await bazaarCard.getByRole('alert').filter({hasText:'Enter a category name'}).waitFor();
   for(const section of ['Bazaar','Snacks']) {
     const card=page.getByRole('heading',{name:section,exact:true}).locator('..');
     await card.getByRole('textbox',{name:`New ${section} category`}).fill(`${section} accessories`);
     await card.getByRole('button',{name:'Add',exact:true}).click();
     const input=card.getByRole('textbox',{name:`Category name ${section} accessories`,exact:true});
     await input.waitFor();
     await input.fill(`${section} gifts`);
     await card.getByRole('button',{name:'Save',exact:true}).click();
     await card.getByRole('textbox',{name:`Category name ${section} gifts`,exact:true}).waitFor();
     await card.getByRole('button',{name:'Deactivate',exact:true}).click();
     await card.getByRole('button',{name:'Activate',exact:true}).waitFor();
     await card.getByRole('button',{name:'Activate',exact:true}).click();
     await card.getByRole('button',{name:'Deactivate',exact:true}).waitFor();
   }
   await bazaarCard.getByRole('textbox',{name:'New Bazaar category'}).fill('Rejected category');
   await bazaarCard.getByRole('button',{name:'Add',exact:true}).click();
   await bazaarCard.getByRole('alert').filter({hasText:'Category update was refused'}).waitFor();
   console.log('PASS category empty-name validation, add, edit, activation and visible server errors');
   await page.getByRole('link',{name:'Supplier lists',exact:true}).click();
   await page.getByLabel('List title',{exact:true}).fill('New supplies');
   await page.getByLabel('Supplier',{exact:true}).selectOption(supplierId);
   await page.getByLabel('Product',{exact:true}).selectOption('1');
   await page.getByRole('button',{name:'Send list',exact:true}).click();
   await page.waitForFunction(()=>!document.body.textContent.includes('An earlier action is unconfirmed'));
   assert.ok(calls.includes('create_supplier_order'));
   const receive=page.getByRole('button',{name:'Confirm received',exact:true});
   assert.equal(await receive.isDisabled(),true);
   Object.assign(orders[0].items[0],{purchased:3,purchased_at:new Date().toISOString()});
   await page.getByRole('button',{name:'Refresh',exact:true}).click();
   await page.getByText('Awaiting supplier delivery confirmation').waitFor();
   assert.equal(await receive.isDisabled(),true);
   Object.assign(orders[0].items[0],{delivered:2,delivered_at:new Date().toISOString()});
   await page.getByRole('button',{name:'Refresh',exact:true}).click();
   await page.getByText('2 delivered units awaiting receipt').waitFor();
   await page.getByRole('spinbutton',{name:'Received quantity for Water'}).fill('3');
   assert.equal(await receive.isDisabled(),true);
   await page.getByRole('spinbutton',{name:'Received quantity for Water'}).fill('2');
   await page.getByRole('spinbutton',{name:'Buying price per item'}).fill('8');
   await receive.click();
   await page.getByRole('cell',{name:'2 / 5',exact:true}).waitFor();
   assert.ok(calls.includes('money_stock'));
   assert.equal(await receive.isDisabled(),true);
   assert.equal(await page.getByRole('spinbutton',{name:'Received quantity for Water'}).inputValue(),'');
   Object.assign(orders[0].items[0],{purchased:5,delivered:5});
   await page.getByRole('button',{name:'Refresh',exact:true}).click();
   await page.getByText('3 delivered units awaiting receipt').waitFor();
   await page.getByRole('spinbutton',{name:'Received quantity for Water'}).fill('3');
   await page.getByRole('spinbutton',{name:'Buying price per item'}).fill('8');
   await receive.click();
   await page.getByRole('cell',{name:'5 / 5',exact:true}).waitFor();
   console.log('PASS receiver requires supplier purchase and delivery and respects partial delivered quantities');
  }
  if(role==='supplier') {
   await page.getByRole('heading',{name:'Weekly supplies',exact:true}).waitFor();
   assert.equal(await page.getByRole('checkbox').count(),0);
   assert.equal(await page.getByRole('button',{name:'Confirm delivered',exact:true}).isDisabled(),true);
   await page.getByRole('spinbutton',{name:'Total bought for Water'}).fill('3');
   await page.getByRole('button',{name:'Confirm purchased',exact:true}).click();
   await page.waitForFunction(()=>document.querySelector('input[aria-label="Total delivered for Water"]')?.max==='3');
   await page.getByRole('spinbutton',{name:'Total delivered for Water'}).fill('4');
   assert.equal(await page.getByRole('button',{name:'Confirm delivered',exact:true}).isDisabled(),true);
   await page.getByRole('spinbutton',{name:'Total delivered for Water'}).fill('2');
   await page.getByRole('button',{name:'Confirm delivered',exact:true}).click();
   await page.getByRole('spinbutton',{name:'Total delivered for Water'}).waitFor();
   assert.ok(calls.includes('supplier_confirm_purchase'));
   assert.ok(calls.includes('supplier_confirm_delivery'));
   assert.equal(calls.includes('money_stock'),false);
   await page.getByRole('spinbutton',{name:'Total bought for Water'}).fill('5');
   await page.getByRole('button',{name:'Confirm purchased',exact:true}).click();
   await page.getByText('Requested quantity bought').waitFor();
   await page.getByRole('spinbutton',{name:'Total delivered for Water'}).fill('5');
   await page.getByRole('button',{name:'Confirm delivered',exact:true}).click();
   await page.getByText('Purchased quantity delivered').waitFor();
   console.log('PASS supplier enters purchased/delivered totals, supports partial batches and cannot receive stock');
   assert.equal(await page.getByRole('button',{name:'Confirm received',exact:true}).count(),0);
   assert.equal(await page.getByRole('heading',{name:'New supplier list'}).count(),0);
   await page.goto(base+'/admin/reports');await page.waitForURL(base+'/supplier');
  }
  if(role==='admin') {
   await page.getByRole('link',{name:'Users',exact:true}).click();
   await page.getByRole('button',{name:'Create user'}).click();
   await page.getByLabel('Role',{exact:true}).waitFor();
   assert.deepEqual(await page.getByLabel('Role',{exact:true}).locator('option').allTextContents(),['Admin','Cashier','Finance','Product Manager','Supplier']);
  }
  console.log('PASS browser',role);
  await context.close();
 }
 assert.deepEqual(errors,[]);
} finally {await browser.close();}
